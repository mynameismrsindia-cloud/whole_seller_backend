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
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, RolesGuard } from './auth';
import { Database } from './database';
import { decodeCursor, pageSize, paginated } from './pagination';
import { AuthenticatedRequest } from './auth';

class CreateSaleDto {
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
    const previous = await this.findIdempotent(user.id, requestId);
    if (previous) return this.assertSameRequest(previous, input);

    try {
      const result = await this.database.transaction(async (client) => {
        const profile = await client.query(
          `SELECT name FROM users WHERE id = $1 AND role = 'seller'`,
          [user.id],
        );
        if (!profile.rows[0]) {
          throw new BadRequestException('A Seller account is required to submit sales.');
        }

        const stock = await client.query(
          `UPDATE products
           SET quantity = quantity - $2, updated_at = now()
           WHERE id = $1 AND active = true AND quantity >= $2
           RETURNING id, name`,
          [input.productId, input.quantity],
        );
        if (!stock.rows[0]) {
          const product = await client.query(
            'SELECT active, quantity FROM products WHERE id = $1',
            [input.productId],
          );
          if (!product.rows[0]) throw new NotFoundException('Product not found.');
          if (!product.rows[0].active) {
            throw new ConflictException('Product is inactive.');
          }
          throw new ConflictException(
            `Insufficient stock. ${product.rows[0].quantity} units are remaining.`,
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
            input.quantity,
            input.rate,
            input.quantity * input.rate,
          ],
        );
        return saleJson(created.rows[0]);
      });
      return result;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const existing = await this.findIdempotent(user.id, requestId);
        if (existing) return this.assertSameRequest(existing, input);
      }
      throw error;
    }
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
       FROM sales WHERE seller_id = $1 AND request_id = $2`,
      [sellerId, requestId],
    );
    return rows[0] ? saleJson(rows[0]) : undefined;
  }

  private assertSameRequest(
    existing: ReturnType<typeof saleJson>,
    input: CreateSaleDto,
  ) {
    const matches =
      existing.productId === input.productId &&
      existing.quantity === input.quantity &&
      existing.rate === input.rate &&
      existing.store === input.store.trim() &&
      existing.contact === input.contact.trim() &&
      existing.location === input.location.trim();
    if (!matches) {
      throw new ConflictException(
        'This idempotency key was already used for different sale details.',
      );
    }
    return existing;
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

  @Patch(':id/approve')
  @Roles('owner')
  approve(@Param('id') id: string) {
    return this.sales.approve(id);
  }
}
