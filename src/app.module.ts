import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StatementModule } from './statement/statement.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    PrismaModule, 
    StatementModule, 
    AuthModule,
    AdminModule,
    ScheduleModule.forRoot()
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
