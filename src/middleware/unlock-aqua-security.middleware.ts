import { Injectable, NestMiddleware, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class UnlockAquaSecurityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UnlockAquaSecurityMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Only apply security to unlock-aqua endpoint
    if (req.path === '/token/unlock-aqua' && req.method === 'POST') {
      this.logger.warn(`🔒 SECURITY CHECK: Unlock-aqua request from ${req.ip}`);
      
      const body = req.body;
      
      // Multiple security validations
      if (!body || 
          typeof body !== 'object' ||
          !body.signedTxXdr || 
          typeof body.signedTxXdr !== 'string' ||
          body.signedTxXdr.trim() === '' ||
          body.signedTxXdr.length < 20) {
        
        this.logger.error('🚨 SECURITY ALERT: Blocked unauthorized unstaking attempt');
        this.logger.error(`Request body: ${JSON.stringify(body)}`);
        this.logger.error(`IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);
        
        throw new HttpException({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'SECURITY: Unauthorized access blocked. Wallet signature required.',
          error: 'Unauthorized',
          details: 'Unstaking requires wallet authentication through the web application.'
        }, HttpStatus.UNAUTHORIZED);
      }

      this.logger.log('✅ SECURITY: Valid signedTxXdr found, proceeding with validation');
    }
    
    next();
  }
} 