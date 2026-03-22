# Distributed Test Execution Engine

A production-grade distributed test execution engine inspired by cloud testing platforms like BrowserStack. This system demonstrates how large-scale cloud testing infrastructure executes, monitors, and manages test jobs reliably with proper concurrency, fault tolerance, and process lifecycle management.

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client API    │    │   WebSocket     │    │   Monitoring    │
│   (Express)     │    │   (Socket.IO)   │    │   (Health)      │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │     Queue Manager         │
                    │    (BullMQ + Redis)       │
                    └─────────────┬─────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │    Worker Manager          │
                    │  (Process Isolation)      │
                    └─────────────┬─────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │   Test Executors          │
                    │  (Child Processes)       │
                    └───────────────────────────┘
```

## 🚀 Features

- **Distributed Architecture**: Redis-backed job queue with BullMQ for scalable job distribution
- **Process Isolation**: Each test runs in isolated child processes to prevent crash propagation
- **Real-time Monitoring**: WebSocket-based log streaming and job status updates
- **Fault Tolerance**: Automatic retries with exponential backoff and dead-letter queue
- **Security**: Input validation, sandboxed execution, and blocked pattern detection
- **Observability**: Health checks, metrics, and structured logging
- **Docker Support**: Complete containerization with docker-compose
- **RESTful API**: Comprehensive API for job submission, monitoring, and management

## 📋 System Requirements

- Node.js 18+ 
- Redis 6+
- Docker & Docker Compose (for containerized deployment)
- Linux/macOS/Windows (with WSL2)

## 🛠️ Tech Stack

- **Backend**: Node.js, TypeScript, Express.js
- **Queue**: BullMQ with Redis
- **Logging**: Winston with daily rotation
- **WebSocket**: Socket.IO
- **Validation**: Joi
- **Security**: Helmet, CORS, Rate Limiting
- **Containerization**: Docker, Docker Compose

## 📁 Project Structure

```
distributed-test-execution-engine/
├── src/
│   ├── api/                    # API layer and routes
│   │   ├── index.ts           # Main API server setup
│   │   └── routes/            # API route handlers
│   │       ├── jobs.ts        # Job management endpoints
│   │       └── system.ts      # System monitoring endpoints
│   ├── queue/                 # Queue management
│   │   ├── redis.ts           # Redis connection manager
│   │   └── manager.ts         # BullMQ queue manager
│   ├── workers/               # Worker processes
│   │   ├── executor.ts        # Test execution engine
│   │   └── manager.ts         # Worker pool manager
│   ├── utils/                 # Utilities
│   │   ├── logger.ts          # Structured logging system
│   │   └── types.ts           # TypeScript type definitions
│   ├── config/                # Configuration management
│   │   └── index.ts           # Environment-based config
│   └── index.ts               # Application entry point
├── docker/                    # Docker configuration
├── logs/                      # Log files (auto-created)
├── temp/                      # Temporary files (auto-created)
├── docker-compose.yml         # Multi-container setup
├── Dockerfile                 # Application container
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript configuration
└── README.md                  # This file
```

## 🚀 Quick Start

### Using Docker Compose (Recommended)

1. **Clone and Setup**
   ```bash
   git clone <repository-url>
   cd distributed-test-execution-engine
   cp .env.example .env
   ```

2. **Start Services**
   ```bash
   docker-compose up -d
   ```

3. **Verify Installation**
   ```bash
   curl http://localhost:3000/api/v1/health
   ```

### Local Development

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start Redis**
   ```bash
   docker run -d -p 6379:6379 redis:7-alpine
   ```

3. **Start Application**
   ```bash
   npm run dev
   ```

## 📖 API Documentation

### Job Management Endpoints

#### Submit Test Job
```bash
curl -X POST http://localhost:3000/api/v1/submit-test \
  -H "Content-Type: application/json" \
  -d '{
    "script": "echo \"Hello World\"",
    "command": "bash",
    "args": ["-c", "echo \"Hello World\""],
    "timeout": 30000,
    "metadata": {"project": "demo"}
  }'
```

#### Get Job Status
```bash
curl http://localhost:3000/api/v1/status/{jobId}
```

#### Get Job Logs
```bash
curl http://localhost:3000/api/v1/logs/{jobId}
```

#### Get Job Result
```bash
curl http://localhost:3000/api/v1/result/{jobId}
```

#### Cancel Job
```bash
curl -X DELETE http://localhost:3000/api/v1/jobs/{jobId}
```

#### Retry Failed Job
```bash
curl -X POST http://localhost:3000/api/v1/jobs/{jobId}/retry
```

### System Monitoring Endpoints

#### Health Check
```bash
curl http://localhost:3000/api/v1/health
```

#### System Metrics
```bash
curl http://localhost:3000/api/v1/metrics
```

#### Queue Statistics
```bash
curl http://localhost:3000/api/v1/queue/stats
```

#### System Information
```bash
curl http://localhost:3000/api/v1/info
```

### Queue Management Endpoints

#### Pause Queue
```bash
curl -X POST http://localhost:3000/api/v1/queue/pause
```

#### Resume Queue
```bash
curl -X POST http://localhost:3000/api/v1/queue/resume
```

#### Clear Queue
```bash
curl -X DELETE http://localhost:3000/api/v1/queue/clear
```

## 🔄 Concurrency Model

The system uses a multi-layered concurrency approach:

1. **Queue Level**: BullMQ handles job distribution with configurable concurrency
2. **Worker Level**: Worker pool manages multiple concurrent test executors
3. **Process Level**: Each test runs in isolated child processes
4. **Resource Management**: Memory and CPU limits prevent resource exhaustion

### Concurrency Configuration

```typescript
// Queue concurrency (jobs processed simultaneously)
QUEUE_CONCURRENCY: 5

// Worker pool size (maximum parallel processes)
WORKER_POOL_SIZE: 10

// Per-job timeout
WORKER_TIMEOUT: 300000 // 5 minutes
```

## 🛡️ Failure Handling Strategy

### Process Isolation
- Each test runs in a separate child process
- Process crashes don't affect other jobs or the main application
- Automatic cleanup of zombie processes

### Retry Logic
- Configurable retry attempts (default: 3)
- Exponential backoff strategy
- Failed jobs moved to dead-letter queue after max retries

### Timeout Management
- Per-job timeout enforcement
- Graceful process termination (SIGTERM)
- Force kill after timeout (SIGKILL)

### Error Recovery
- Automatic worker restart on crashes
- Queue state persistence via Redis
- Graceful shutdown handling

## 📊 Process Lifecycle Management

### Job Execution Flow

1. **Submission**: API validates and queues job
2. **Queuing**: BullMQ stores job with metadata
3. **Processing**: Worker picks up job and spawns executor
4. **Execution**: Isolated process runs the test
5. **Monitoring**: Real-time log streaming and progress updates
6. **Completion**: Results stored and notifications sent

### Process States

```
PENDING → RUNNING → COMPLETED/FAILED/TIMEOUT
    ↓         ↓           ↓
  Queue    Worker      Storage
```

### Resource Management

- **Memory Limits**: Configurable per-process memory caps
- **CPU Management**: Worker pool size limits concurrent processes
- **Disk Cleanup**: Automatic cleanup of temporary files
- **Log Rotation**: Daily log file rotation with size limits

## 🔧 Configuration

### Environment Variables

Key configuration options (see `.env.example` for complete list):

```bash
# Server
PORT=3000
HOST=0.0.0.0

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Queue
QUEUE_CONCURRENCY=5
QUEUE_ATTEMPTS=3

# Workers
WORKER_POOL_SIZE=10
WORKER_TIMEOUT=300000

# Security
SECURITY_MAX_SCRIPT_LENGTH=100000
WORKER_SANDBOX=true
```

### Security Features

- **Input Validation**: Joi schema validation for all API inputs
- **Pattern Blocking**: Prevents dangerous system calls
- **Command Whitelisting**: Only allowed commands can be executed
- **Resource Limits**: Memory and timeout restrictions
- **Sandbox Mode**: Isolated execution environment

## 🐳 Docker Deployment

### Build Image
```bash
docker build -t test-execution-engine .
```

### Run with Docker Compose
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Production Considerations

- Use environment variables for configuration
- Mount persistent volumes for logs
- Configure health checks
- Set appropriate resource limits
- Use reverse proxy (nginx) for SSL termination

## 📈 Monitoring & Observability

### Health Checks
- Application health endpoint
- Redis connectivity check
- Worker status monitoring
- Queue health assessment

### Metrics Available
- Job counts by status
- Worker pool statistics
- Memory usage tracking
- CPU utilization
- Execution time averages

### Logging Strategy
- Structured JSON logging
- Per-job log files
- Daily log rotation
- Error-specific log files
- Real-time log streaming via WebSocket

## 🧪 Example Usage

### Simple Script Execution
```bash
curl -X POST http://localhost:3000/api/v1/submit-test \
  -H "Content-Type: application/json" \
  -d '{
    "script": "echo \"Test completed successfully\"",
    "timeout": 10000
  }'
```

### Node.js Test Execution
```bash
curl -X POST http://localhost:3000/api/v1/submit-test \
  -H "Content-Type: application/json" \
  -d '{
    "command": "node",
    "args": ["-e", "console.log(\"Node.js test passed\")"],
    "timeout": 15000
  }'
```

### Python Test Execution
```bash
curl -X POST http://localhost:3000/api/v1/submit-test \
  -H "Content-Type: application/json" \
  -d '{
    "command": "python3",
    "args": ["-c", "print(\"Python test passed\")"],
    "timeout": 15000
  }'
```

## 🔍 WebSocket Integration

### Real-time Updates
```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:3000');

// Subscribe to job updates
socket.emit('subscribe-job', 'job-id-here');

// Listen for events
socket.on('job-completed', (data) => {
  console.log('Job completed:', data);
});

socket.on('job-failed', (data) => {
  console.log('Job failed:', data);
});

socket.on('job-progress', (data) => {
  console.log('Job progress:', data);
});
```

## 🚨 Troubleshooting

### Common Issues

1. **Redis Connection Failed**
   - Ensure Redis is running on configured host/port
   - Check network connectivity
   - Verify Redis credentials

2. **Worker Timeout**
   - Increase `WORKER_TIMEOUT` for long-running tests
   - Check system resources
   - Monitor job complexity

3. **Memory Issues**
   - Reduce `WORKER_POOL_SIZE`
   - Increase system memory
   - Enable memory monitoring

4. **Permission Errors**
   - Check file permissions for temp directory
   - Verify user has execution rights
   - Run with appropriate user context

### Debug Mode

Enable debug logging:
```bash
LOG_LEVEL=debug npm run dev
```

### Health Monitoring

```bash
# Check system health
curl http://localhost:3000/api/v1/health

# Monitor queue stats
curl http://localhost:3000/api/v1/queue/stats

# View system metrics
curl http://localhost:3000/api/v1/metrics
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Inspired by BrowserStack's distributed testing architecture
- Built with modern Node.js ecosystem tools
- Follows production-ready best practices
- Implements enterprise-grade patterns for scalability and reliability
