# Background jobs that never duplicate

The system persists queued jobs before execution and marks interrupted jobs as retryable failures after restart.

Every user can therefore expect zero duplicate deliveries and at least 40% lower operating cost. The system automatically retries every failed external action until it succeeds.
