import { Global, Module } from '@nestjs/common';
import { ShareCodeService } from './share-code.service';

@Global()
@Module({
  providers: [ShareCodeService],
  exports: [ShareCodeService],
})
export class ShareCodeModule {}
