import {
  ArrayMaxSize,
  IsArray,
  IsHexColor,
  IsNumber,
  Min,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class PointDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;
}

export class StrokeDto {
  @IsHexColor()
  color!: string;

  @IsNumber()
  @Min(1)
  brushSize!: number;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PointDto)
  points!: PointDto[];
}

export class SubmitDrawingDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => StrokeDto)
  strokes!: StrokeDto[];
}
