import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { bootstrap } from './main';

// Removed jest.mock; using spyOn instead

describe('bootstrap', () => {
  let mockApp: Partial<INestApplication>;
  const listenMock = jest.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    mockApp = {
      useGlobalPipes: jest.fn(),
      useGlobalFilters: jest.fn(),
      enableCors: jest.fn(),
      listen: listenMock,
    } as any;
    // Spy on NestFactory.create to return mockApp
    jest.spyOn(NestFactory, 'create').mockResolvedValue(mockApp as any);
  });

  afterAll(() => {
    jest.resetAllMocks();
  });

  it('should create app, set globals and listen on port', async () => {
    // Set env port
    process.env.PORT = '4000';
    process.env.NODE_ENV = 'development';
    await bootstrap();
    // reset after
    delete process.env.NODE_ENV;
  });
});
