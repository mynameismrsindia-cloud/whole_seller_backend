import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  Injectable,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, RolesGuard } from './auth';
import { Database } from './database';
import { decodeCursor, pageSize, paginated } from './pagination';
import { AuthenticatedRequest } from './auth';

class CreateSaleItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  rate!: number;
}

class CreateSaleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  productId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  rate?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(10, { message: 'A sale can include at most 10 products.' })
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items?: CreateSaleItemDto[];

  @IsString()
  @MaxLength(160)
  store!: string;

  @IsString()
  @MaxLength(80)
  contact!: string;

  @IsString()
  @MaxLength(160)
  location!: string;
}

interface SaleRow {
  id: string;
  request_id: string;
  seller_id: string;
  salesman: string;
  store: string;
  contact: string;
  location: string;
  product_id: string;
  product_name: string;
  quantity: number;
  rate: number;
  total_amount: string | number;
  order_status: 'pending' | 'approved';
  created_at: Date;
  updated_at: Date;
}

function saleJson(row: SaleRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    sellerId: row.seller_id,
    userId: row.seller_id,
    salesman: row.salesman,
    store: row.store,
    contact: row.contact,
    location: row.location,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    rate: row.rate,
    totalAmount: Number(row.total_amount),
    orderStatus: row.order_status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

@Injectable()
export class SalesService {
  constructor(private readonly database: Database) {}

  async create(
    user: AuthUser,
    keyHeader: string | string[] | undefined,
    input: CreateSaleDto,
  ) {
    const requestId = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (
      !requestId ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)
    ) {
      throw new BadRequestException('A UUID Idempotency-Key header is required.');
    }
    if (
      !input.store.trim() ||
      !input.contact.trim() ||
      !input.location.trim()
    ) {
      throw new BadRequestException('Store, contact, and location are required.');
    }

    const items = this.normalizeItems(input);
    if (items.length === 0) {
      throw new BadRequestException('At least one product is required.');
    }
    if (items.length > 10) {
      throw new BadRequestException('A sale can include at most 10 products.');
    }
    if (new Set(items.map((item) => item.productId)).size !== items.length) {
      throw new BadRequestException('A product can only appear once in a sale.');
    }

    const previous = await this.findIdempotent(user.id, requestId);
    if (previous.length > 0) return this.assertSameRequest(previous, items, input);

    try {
      const result = await this.database.transaction(async (client) => {
        const profile = await client.query(
          `SELECT name FROM users WHERE id = $1 AND role = 'seller'`,
          [user.id],
        );
        if (!profile.rows[0]) {
          throw new BadRequestException('A Seller account is required to submit sales.');
        }

        const createdRows: SaleRow[] = [];
        for (const item of items) {
          const stock = await client.query(
            `UPDATE products
             SET quantity = quantity - $2, updated_at = now()
             WHERE id = $1 AND active = true AND quantity >= $2
             RETURNING id, name`,
            [item.productId, item.quantity],
          );
          if (!stock.rows[0]) {
            const product = await client.query(
              'SELECT active, quantity FROM products WHERE id = $1',
              [item.productId],
            );
            if (!product.rows[0]) throw new NotFoundException('Product not found.');
            if (!product.rows[0].active) {
              throw new ConflictException('Product is inactive.');
            }
            throw new ConflictException(
              `Insufficient stock for ${item.productId}. ${product.rows[0].quantity} units are remaining.`,
            );
          }

          const created = await client.query<SaleRow>(
            `INSERT INTO sales
             (request_id, seller_id, salesman, store, contact, location,
              product_id, product_name, quantity, rate, total_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, request_id, seller_id, salesman, store, contact,
               location, product_id, product_name, quantity, rate, total_amount,
               order_status, created_at, updated_at`,
            [
              requestId,
              user.id,
              profile.rows[0].name,
              input.store.trim(),
              input.contact.trim(),
              input.location.trim(),
              stock.rows[0].id,
              stock.rows[0].name,
              item.quantity,
              item.rate,
              item.quantity * item.rate,
            ],
          );
          createdRows.push(created.rows[0]);
        }

        createdRows.sort((left, right) =>
          left.product_id.localeCompare(right.product_id),
        );
        return createdRows.length === 1
          ? saleJson(createdRows[0])
          : {
              requestId,
              items: createdRows.map((row) => saleJson(row)),
              totalAmount: createdRows.reduce(
                (sum, row) => sum + Number(row.total_amount),
                0,
              ),
            };
      });
      return result;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const existing = await this.findIdempotent(user.id, requestId);
        if (existing.length > 0) return this.assertSameRequest(existing, items, input);
      }
      throw error;
    }
  }

  private normalizeItems(input: CreateSaleDto) {
    if (input.items !== undefined) {
      if (
        input.productId !== undefined ||
        input.quantity !== undefined ||
        input.rate !== undefined
      ) {
        throw new BadRequestException(
          'Use either items or the single-product fields, not both.',
        );
      }
      return input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        rate: item.rate,
      }));
    }

    if (input.productId && input.quantity !== undefined && input.rate !== undefined) {
      return [{
        productId: input.productId,
        quantity: input.quantity,
        rate: input.rate,
      }];
    }

    return [];
  }

  async list(
    user: AuthUser,
    startValue: string | undefined,
    endValue: string | undefined,
    cursor: ReturnType<typeof decodeCursor>,
    limit: number,
  ) {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (user.role !== 'owner') {
      values.push(user.id);
      filters.push(`seller_id = $${values.length}`);
    }
    if (startValue) {
      const start = new Date(startValue);
      if (!Number.isFinite(start.getTime())) throw new BadRequestException('start date is invalid.');
      values.push(start.toISOString());
      filters.push(`created_at >= $${values.length}`);
    }
    if (endValue) {
      const end = new Date(endValue);
      if (!Number.isFinite(end.getTime())) throw new BadRequestException('end date is invalid.');
      values.push(end.toISOString());
      filters.push(`created_at < $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      filters.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await this.database.query<SaleRow>(
      `SELECT id, request_id, seller_id, salesman, store, contact, location,
         product_id, product_name, quantity, rate, total_amount, order_status,
         created_at, updated_at
       FROM sales ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    return paginated(rows, limit, saleJson);
  }

  async listOrder(user: AuthUser, requestId: string) {
    const values: unknown[] = [requestId];
    let sellerFilter = '';
    if (user.role !== 'owner') {
      values.push(user.id);
      sellerFilter = ` AND seller_id = $${values.length}`;
    }
    const { rows } = await this.database.query<SaleRow>(
      `SELECT id, request_id, seller_id, salesman, store, contact, location,
         product_id, product_name, quantity, rate, total_amount, order_status,
         created_at, updated_at
       FROM sales
       WHERE request_id = $1${sellerFilter}
       ORDER BY product_name ASC, product_id ASC`,
      values,
    );
    if (rows.length === 0) throw new NotFoundException('Sale order not found.');
    return { items: rows.map(saleJson) };
  }

  async approve(id: string) {
    const { rows } = await this.database.query<SaleRow>(
      `UPDATE sales SET order_status = 'approved', updated_at = now()
       WHERE id = $1 AND order_status = 'pending'
       RETURNING id, request_id, seller_id, salesman, store, contact, location,
         product_id, product_name, quantity, rate, total_amount, order_status,
         created_at, updated_at`,
      [id],
    );
    if (rows[0]) return saleJson(rows[0]);
    const existing = await this.database.query(
      'SELECT order_status FROM sales WHERE id = $1',
      [id],
    );
    if (!existing.rowCount) throw new NotFoundException('Sale not found.');
    throw new ConflictException('A sale can only be approved once.');
  }

  private async findIdempotent(sellerId: string, requestId: string) {
    const { rows } = await this.database.query<SaleRow>(
      `SELECT id, request_id, seller_id, salesman, store, contact, location,
         product_id, product_name, quantity, rate, total_amount, order_status,
         created_at, updated_at
       FROM sales WHERE seller_id = $1 AND request_id = $2 ORDER BY created_at ASC, id ASC`,
      [sellerId, requestId],
    );
    return rows;
  }

  private assertSameRequest(
    existing: SaleRow[],
    items: { productId: string; quantity: number; rate: number }[],
    input: CreateSaleDto,
  ) {
    existing.sort((left, right) =>
      left.product_id.localeCompare(right.product_id),
    );
    const actual = existing.map((row) => ({
      productId: row.product_id,
      quantity: row.quantity,
      rate: row.rate,
    })).sort((a, b) => a.productId.localeCompare(b.productId));
    const expected = items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      rate: item.rate,
    })).sort((a, b) => a.productId.localeCompare(b.productId));

    const matches =
      existing.length === expected.length &&
      existing.every((row) => {
        return (
          row.store === input.store.trim() &&
          row.contact === input.contact.trim() &&
          row.location === input.location.trim()
        );
      }) &&
      JSON.stringify(actual) === JSON.stringify(expected);

    if (!matches) {
      throw new ConflictException(
        'This idempotency key was already used for different sale details.',
      );
    }

    return existing.length === 1
      ? saleJson(existing[0])
      : {
          requestId: existing[0].request_id,
          items: existing.map((row) => saleJson(row)),
          totalAmount: existing.reduce(
            (sum, row) => sum + Number(row.total_amount),
            0,
          ),
        };
  }
}

@Controller('sales')
@UseGuards(AuthGuard, RolesGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateSaleDto,
  ) {
    return this.sales.create(user, request.headers['idempotency-key'], body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('start') startValue?: string,
    @Query('end') endValue?: string,
    @Query('cursor') cursorValue?: string,
    @Query('limit') limitValue?: string,
  ) {
    return this.sales.list(
      user,
      startValue,
      endValue,
      decodeCursor(cursorValue),
      pageSize(limitValue),
    );
  }

  @Get('orders/:requestId')
  listOrder(
    @CurrentUser() user: AuthUser,
    @Param('requestId') requestId: string,
  ) {
    return this.sales.listOrder(user, requestId);
  }

  @Patch(':id/approve')
  @Roles('owner')
  approve(@Param('id') id: string) {
    return this.sales.approve(id);
  }
}
