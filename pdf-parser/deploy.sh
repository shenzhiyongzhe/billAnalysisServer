#!/bin/bash
# Exit on error
set -e

IMAGE_NAME="pdf-parser"
CONTAINER_NAME="pdf-parser"
PORT=8000

echo "Building Docker image..."
docker build -t ${IMAGE_NAME}:latest .

echo "Stopping existing container if it exists..."
docker stop ${CONTAINER_NAME} || true
docker rm ${CONTAINER_NAME} || true

echo "Starting new container..."
docker run -d \
  --name ${CONTAINER_NAME} \
  -p ${PORT}:8000 \
  --restart always \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  ${IMAGE_NAME}:latest

echo "Deployment complete! Service is running on port ${PORT}."
