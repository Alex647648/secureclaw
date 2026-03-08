#!/bin/bash
# 构建 SecureClaw agent 容器镜像

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="secureclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building SecureClaw agent container image..."
echo "Runtime: ${CONTAINER_RUNTIME}"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  SC_SESSION_ID=test SC_SESSION_TOKEN=test SC_GROUP_ID=main SC_TRUST_LEVEL=standard SC_PROMPT=\$(echo 'hello' | base64) \\"
echo "    ${CONTAINER_RUNTIME} run --rm ${IMAGE_NAME}:${TAG}"
