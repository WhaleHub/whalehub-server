#!/bin/bash

# Set memory environment variables
export NODE_OPTIONS="--max-old-space-size=4096 --optimize-for-size --gc-interval=100 --expose-gc"
export UV_THREADPOOL_SIZE=16

# Create logs directory if it doesn't exist
mkdir -p logs

# Start the application with memory monitoring
echo "Starting application with memory optimizations..."
echo "Node options: $NODE_OPTIONS"
echo "Memory limit: 4GB"
echo "UV Thread pool size: $UV_THREADPOOL_SIZE"

# Run the application
node dist/main.js 