import { Injectable, NestMiddleware, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class UnlockAquaSecurityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UnlockAquaSecurityMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Only apply security to unlock-aqua endpoint
    if (req.path === '/token/unlock-aqua' && req.method === 'POST') {
      this.logger.warn(`🔒 SECURITY CHECK: Unlock-aqua request from ${req.ip}`);
      
      const userAgent = (req.get('User-Agent') || '').toLowerCase();
      const body = req.body;

      const hasValidXdr = !!(
        body &&
        typeof body === 'object' &&
        typeof body.signedTxXdr === 'string' &&
        body.signedTxXdr.trim() !== '' &&
        body.signedTxXdr.length >= 20
      );

      // Only block direct curl attempts explicitly when XDR is missing/invalid
      if (userAgent.includes('curl') && !hasValidXdr) {
        this.logger.error('🚫 SECURITY: Blocked curl client for unlock-aqua endpoint (missing/invalid signedTxXdr)');
        throw new HttpException({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'SECURITY: Direct command-line access without a valid signed transaction is not allowed. Please use the web application with a connected wallet.',
          error: 'Unauthorized',
        }, HttpStatus.UNAUTHORIZED);
      }

      if (!hasValidXdr) {
        // Allow request to proceed so controller/DTO validation can return 400 instead of hard 401 here
        this.logger.warn('⚠️ SECURITY: No valid signedTxXdr found in request body; delegating to controller validation');
      } else {
        this.logger.log('✅ SECURITY: Valid signedTxXdr found, proceeding');
      }
    }
    
    next();
  }
} 