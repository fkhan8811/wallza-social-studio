import { Global, Module } from '@nestjs/common';
import { UploadFactory } from './upload.factory';
import { SsrfMediaIngestionService } from './ssrf-media-ingestion.service';

@Global()
@Module({
  providers: [UploadFactory, SsrfMediaIngestionService],
  exports: [UploadFactory, SsrfMediaIngestionService],
})
export class UploadModule {}
