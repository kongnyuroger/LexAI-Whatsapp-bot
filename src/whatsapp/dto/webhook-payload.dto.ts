import { Type } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// Shapes below follow the WhatsApp Cloud API webhook notification format
// (Graph API v25.0), confirmed against Meta's official docs and reference
// payloads as of June 2026: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
// Only the fields this bot currently reads are validated strictly; message
// "content" fields (text/image/document) are typed loosely since WhatsApp
// has many more message types than this bot acts on today. `contacts` is
// never read by this bot at all (only `messages` is), and its real-world
// shape varies (e.g. `profile` can be absent) — validating it strictly was
// rejecting otherwise-legitimate webhook deliveries, so it's left untyped.

export class WebhookMessageDto {
  @IsString()
  from!: string;

  @IsString()
  id!: string;

  @IsString()
  timestamp!: string;

  @IsString()
  type!: string;

  @IsOptional()
  @IsObject()
  text?: { body: string };

  @IsOptional()
  @IsObject()
  image?: { id: string; mime_type: string; sha256?: string };

  @IsOptional()
  @IsObject()
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    sha256?: string;
  };
}

export class WebhookMetadataDto {
  @IsString()
  display_phone_number!: string;

  @IsString()
  phone_number_id!: string;
}

export class WebhookValueDto {
  @IsString()
  messaging_product!: string;

  @ValidateNested()
  @Type(() => WebhookMetadataDto)
  metadata!: WebhookMetadataDto;

  @IsOptional()
  @IsArray()
  contacts?: unknown[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookMessageDto)
  messages?: WebhookMessageDto[];

  @IsOptional()
  @IsArray()
  statuses?: unknown[];
}

export class WebhookChangeDto {
  @ValidateNested()
  @Type(() => WebhookValueDto)
  value!: WebhookValueDto;

  @IsString()
  field!: string;
}

export class WebhookEntryDto {
  @IsString()
  id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookChangeDto)
  changes!: WebhookChangeDto[];
}

export class WebhookPayloadDto {
  @IsString()
  object!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookEntryDto)
  entry!: WebhookEntryDto[];
}
