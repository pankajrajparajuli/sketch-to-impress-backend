import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { HttpExceptionFilter } from './http-exception.filter';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it('should format HttpException details into standard JSON response body', () => {
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    const mockResponse = {
      status: mockStatus,
    };

    const mockRequest = {
      url: '/api/test',
      method: 'POST',
    };

    const mockHost = {
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;

    const exception = new HttpException(
      'Invalid DTO payload input',
      HttpStatus.BAD_REQUEST,
    );
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: HttpStatus.BAD_REQUEST,
        path: '/api/test',
        method: 'POST',
        message: 'Invalid DTO payload input',
      }),
    );
  });

  it('should extract error messages from structured objects inside HttpExceptions', () => {
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    const mockResponse = {
      status: mockStatus,
    };

    const mockRequest = {
      url: '/api/test',
      method: 'GET',
    };

    const mockHost = {
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;

    const exception = new HttpException(
      {
        message: ['username must be alphanumeric', 'password too short'],
        error: 'Bad Request',
      },
      HttpStatus.BAD_REQUEST,
    );
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: HttpStatus.BAD_REQUEST,
        message: ['username must be alphanumeric', 'password too short'],
      }),
    );
  });

  it('should ignore non-http context executions', () => {
    const mockHost = {
      getType: () => 'ws',
    } as any;

    const exception = new HttpException(
      'Test HTTP exception',
      HttpStatus.BAD_REQUEST,
    );
    expect(() => filter.catch(exception, mockHost)).not.toThrow();
  });
});
