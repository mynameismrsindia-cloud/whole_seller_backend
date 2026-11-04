import { Controller, Get, Injectable } from '@nestjs/common';
import { Database } from './database';

@Injectable()
export class HealthService {
  constructor(private readonly database: Database) {}

  async check(): Promise<{ status: 'ok' }> {
    await this.database.query('SELECT 1');
    return { status: 'ok' };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<{ status: 'ok' }> {
    return this.health.check();
  }
}
