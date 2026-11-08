import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, RolesGuard } from './auth';
import { Database } from './database';
import { decodeCursor, pageSize, paginated } from './pagination';

class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  quantity!: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class RestockDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;
}

interface ProductRow {
  id: string;
  name: string;
  quantity: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function productJson(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

@Injectable()
export class ProductsService {
  constructor(private readonly database: Database) {}

  async list(user: AuthUser, query: string, cursor: ReturnType<typeof decodeCursor>, limit: number) {
    if (query.length > 80) throw new BadRequestException('Search text is too long.');
    const values: unknown[] = [];
    const filters = [];
    if (user.role !== 'owner') filters.push('active = true');
    if (query) {
      values.push(`${query.toLowerCase()}%`);
      filters.push(`lower(name) LIKE $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      filters.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await this.database.query<ProductRow>(
      `SELECT id, name, quantity, active, created_at, updated_at
       FROM products ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return paginated(rows, limit, productJson);
  }

  async create(input: CreateProductDto) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = randomBytes(3).toString('hex').toUpperCase();
      try {
        const { rows } = await this.database.query<ProductRow>(
          `INSERT INTO products (id, name, quantity, active)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, quantity, active, created_at, updated_at`,
          [id, input.name.trim(), input.quantity, input.active ?? true],
        );
        return productJson(rows[0]);
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        if (attempt === 4) {
          throw new ConflictException(
            'Could not generate a unique product ID. Please try again.',
          );
        }
      }
    }
    throw new ConflictException(
      'Could not generate a unique product ID. Please try again.',
    );
  }

  async update(id: string, input: UpdateProductDto) {
    const { rows } = await this.database.query<ProductRow>(
      `UPDATE products
       SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = now()
       WHERE id = $1
       RETURNING id, name, quantity, active, created_at, updated_at`,
      [id, input.name?.trim() ?? null, input.active ?? null],
    );
    if (!rows[0]) throw new NotFoundException('Product not found.');
    return productJson(rows[0]);
  }

  async restock(id: string, quantity: number) {
    const { rows } = await this.database.query<ProductRow>(
      `UPDATE products SET quantity = quantity + $2, updated_at = now()
       WHERE id = $1 AND quantity <= 1000000000 - $2
       RETURNING id, name, quantity, active, created_at, updated_at`,
      [id, quantity],
    );
    if (!rows[0]) {
      const exists = await this.database.query('SELECT 1 FROM products WHERE id = $1', [id]);
      if (!exists.rowCount) throw new NotFoundException('Product not found.');
      throw new BadRequestException('Restock would exceed the stock limit.');
    }
    return productJson(rows[0]);
  }
}

@Controller('products')
@UseGuards(AuthGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('q') query?: string,
    @Query('cursor') cursorValue?: string,
    @Query('limit') limitValue?: string,
  ) {
    return this.products.list(
      user,
      query?.trim() ?? '',
      decodeCursor(cursorValue),
      pageSize(limitValue),
    );
  }

  @Post()
  @Roles('owner')
  create(@Body() body: CreateProductDto) {
    return this.products.create(body);
  }

  @Patch(':id')
  @Roles('owner')
  update(@Param('id') id: string, @Body() body: UpdateProductDto) {
    if (body.name === undefined && body.active === undefined) {
      throw new BadRequestException('Provide a product name or active status.');
    }
    return this.products.update(id, body);
  }

  @Post(':id/restock')
  @Roles('owner')
  restock(@Param('id') id: string, @Body() body: RestockDto) {
    return this.products.restock(id, body.quantity);
  }
}
