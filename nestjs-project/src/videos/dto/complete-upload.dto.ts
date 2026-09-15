import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartInputDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartInputDto)
  parts: UploadPartInputDto[];
}
