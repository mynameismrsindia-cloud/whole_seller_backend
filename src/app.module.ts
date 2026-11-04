import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, RolesGuard } from './auth';
import { AuthController, AuthService } from './auth.controller';
import { Database } from './database';
import { HealthController, HealthService } from './health.controller';
import { ProductsController, ProductsService } from './products.controller';
import { SalesController, SalesService } from './sales.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { ttl: 60_000, limit: 120 },
    ]),
  ],
  controllers: [AuthController, HealthController, ProductsController, SalesController],
  providers: [
    Database,
    AuthService,
    HealthService,
    ProductsService,
    SalesService,
    AuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
