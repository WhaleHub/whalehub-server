import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class MemoryMonitorService {
  private readonly logger = new Logger(MemoryMonitorService.name);
  private readonly MAX_MEMORY_THRESHOLD = 0.85; // 85% of available memory
  private readonly CRITICAL_MEMORY_THRESHOLD = 0.95; // 95% of available memory

  @Cron(CronExpression.EVERY_30_SECONDS)
  monitorMemoryUsage() {
    const memUsage = process.memoryUsage();
    const totalMemory = require('os').totalmem();
    const freeMemory = require('os').freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsagePercentage = usedMemory / totalMemory;

    // Log memory statistics
    this.logger.debug(`Memory Usage:
      RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB
      Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
      Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB
      External: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB
      System Memory Usage: ${(memoryUsagePercentage * 100).toFixed(2)}%
    `);

    // Trigger garbage collection if memory usage is high
    if (memoryUsagePercentage > this.MAX_MEMORY_THRESHOLD) {
      this.logger.warn(`High memory usage detected: ${(memoryUsagePercentage * 100).toFixed(2)}%`);
      this.forceGarbageCollection();
    }

    // Critical memory usage warning
    if (memoryUsagePercentage > this.CRITICAL_MEMORY_THRESHOLD) {
      this.logger.error(`CRITICAL: Memory usage at ${(memoryUsagePercentage * 100).toFixed(2)}%`);
    }
  }

  private forceGarbageCollection() {
    if (global.gc) {
      global.gc();
      this.logger.debug('Forced garbage collection executed');
    } else {
      this.logger.warn('Garbage collection not available. Run with --expose-gc flag');
    }
  }

  getMemoryStats() {
    const memUsage = process.memoryUsage();
    const totalMemory = require('os').totalmem();
    const freeMemory = require('os').freemem();
    
    return {
      rss: memUsage.rss,
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      systemTotal: totalMemory,
      systemFree: freeMemory,
      systemUsed: totalMemory - freeMemory,
      systemUsagePercentage: ((totalMemory - freeMemory) / totalMemory) * 100
    };
  }
} 