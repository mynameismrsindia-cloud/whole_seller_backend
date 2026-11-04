import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { AuthGuard, AuthUser, CurrentUser, RolesGuard } from './auth';
import { Database } from './database';

class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

class RefreshDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  refreshToken!: string;
}

class LogoutDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  refreshToken!: string;
}

class UpdateProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(160)
  storeName!: string;

  @IsString()
  @MaxLength(80)
  contact!: string;

  @IsString()
  @MaxLength(160)
  location!: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'seller';
  storeName: string;
  contact: string;
  location: string;
}

function publicUser(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role === 'owner' ? 'owner' : 'seller',
    storeName: String(row.store_name ?? ''),
    contact: String(row.contact ?? ''),
    location: String(row.location ?? ''),
  };
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(private readonly database: Database) {}

  async register(input: RegisterDto) {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    try {
      const { rows } = await this.database.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, 'seller')
         RETURNING id, email, name, role, store_name, contact, location`,
        [email, passwordHash, input.name.trim()],
      );
      return this.createSession(publicUser(rows[0]));
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new UnauthorizedException('Unable to register with those details.');
      }
      throw error;
    }
  }

  async login(input: LoginDto) {
    const { rows } = await this.database.query(
      `SELECT id, email, name, role, store_name, contact, location, password_hash
       FROM users WHERE lower(email) = lower($1)`,
      [input.email.trim()],
    );
    const user = rows[0] as (Record<string, unknown> & { password_hash: string }) | undefined;
    if (!user || !(await argon2.verify(user.password_hash, input.password))) {
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    return this.createSession(publicUser(user));
  }

  async refresh(rawToken: string) {
    const refreshToken = randomBytes(48).toString('base64url');
    const digest = tokenDigest(rawToken);
    const nextDigest = tokenDigest(refreshToken);
    const nextExpiry = new Date(
      Date.now() + Number(process.env.REFRESH_TOKEN_DAYS ?? 30) * 86_400_000,
    );

    const result = await this.database.transaction(async (client) => {
      const found = await client.query(
        `SELECT rt.id AS token_id, rt.user_id, rt.family_id, rt.expires_at,
                rt.revoked_at, rt.user_id AS id, u.email, u.name, u.role,
                u.store_name, u.contact,
                u.location
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt`,
        [digest],
      );
      const row = found.rows[0] as
        | (Record<string, unknown> & {
            token_id: string;
            user_id: string;
            family_id: string;
            expires_at: Date;
            revoked_at: Date | null;
          })
        | undefined;
      if (!row) return { error: 'invalid' as const };
      if (row.revoked_at) {
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
           WHERE family_id = $1`,
          [row.family_id],
        );
        return { error: 'replayed' as const };
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
          [row.token_id],
        );
        return { error: 'expired' as const };
      }

      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
        [row.token_id],
      );
      await client.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [row.user_id, row.family_id, nextDigest, nextExpiry],
      );
      return {
        user: publicUser(row),
        refreshToken,
      };
    });
    if ('error' in result) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }
    return this.sessionResponse(result.user, result.refreshToken, nextExpiry);
  }

  async logout(rawToken: string): Promise<void> {
    await this.database.query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE token_hash = $1`,
      [tokenDigest(rawToken)],
    );
  }

  async me(id: string) {
    const { rows } = await this.database.query(
      `SELECT id, email, name, role, store_name, contact, location
       FROM users WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new UnauthorizedException('Account no longer exists.');
    return publicUser(rows[0]);
  }

  async updateProfile(id: string, input: UpdateProfileDto) {
    const { rows } = await this.database.query(
      `UPDATE users
       SET name = $2, store_name = $3, contact = $4, location = $5, updated_at = now()
       WHERE id = $1
       RETURNING id, email, name, role, store_name, contact, location`,
      [
        id,
        input.name.trim(),
        input.storeName.trim(),
        input.contact.trim(),
        input.location.trim(),
      ],
    );
    if (!rows[0]) throw new UnauthorizedException('Account no longer exists.');
    return publicUser(rows[0]);
  }

  private async createSession(user: UserRow) {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() + Number(process.env.REFRESH_TOKEN_DAYS ?? 30) * 86_400_000,
    );
    await this.database.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, randomUUID(), tokenDigest(refreshToken), expiresAt],
    );
    return this.sessionResponse(user, refreshToken, expiresAt);
  }

  private sessionResponse(user: UserRow, refreshToken: string, expiresAt: Date) {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes.');
    }
    const accessToken = jwt.sign(
      { role: user.role },
      secret,
      {
        subject: user.id,
        expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as jwt.SignOptions['expiresIn'],
        issuer: 'wholesale-api',
        audience: 'wholesale-apps',
      },
    );
    return {
      accessToken,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
      user,
    };
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.auth.login(body);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: LogoutDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @UseGuards(AuthGuard, RolesGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  @UseGuards(AuthGuard, RolesGuard)
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(user.id, body);
  }
}
