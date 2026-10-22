#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// 소켓이 받아들인 바이트를 센다. 클라이언트 전체 수신/ACK를 증명하는 값은 아니다.
struct JpegWriteResult {
  size_t queuedBytes = 0;
  uint32_t elapsedMs = 0;
  bool complete = false;
};

// JPEG은 원본 프레임버퍼를 유지한 채 내부 RAM의 작은 블록을 거쳐 전송한다.
// now/idle은 보드에서 millis()/delay(1), 호스트 테스트에서는 제어 가능한 함수다.
// budgetMs는 write 호출 사이에 확인하며, 소켓 write 내부의 blocking 시간까지
// 강제로 중단하는 hard deadline은 아니다.
template <typename Client, typename Clock, typename Idle>
JpegWriteResult writeJpegBody(Client& client, const uint8_t* jpeg, size_t length,
                             Clock now, Idle idle, uint32_t budgetMs = 2000) {
  JpegWriteResult result;
  const uint32_t started = now();
  uint8_t block[512];
  while (result.queuedBytes < length && client.connected()) {
    if (static_cast<uint32_t>(now() - started) >= budgetMs) break;
    size_t count = length - result.queuedBytes;
    if (count > sizeof(block)) count = sizeof(block);
    memcpy(block, jpeg + result.queuedBytes, count);
    const size_t accepted = client.write(block, count);
    if (accepted == 0 || accepted > count) break;
    result.queuedBytes += accepted;
    idle();
  }
  result.elapsedMs = static_cast<uint32_t>(now() - started);
  result.complete = result.queuedBytes == length;
  return result;
}
