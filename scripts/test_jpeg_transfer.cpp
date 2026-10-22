#include <assert.h>
#include <algorithm>
#include <stdint.h>
#include <vector>
#include "../firmware/clipsense_cam/jpeg_transfer.h"

struct FakeClient {
  size_t maxWrite = 512;
  bool online = true;
  std::vector<uint8_t> received;
  std::vector<size_t> writes;
  bool connected() { return online; }
  size_t write(const uint8_t* data, size_t count) {
    assert(count <= 512);
    writes.push_back(count);
    const size_t take = std::min(count, maxWrite);
    received.insert(received.end(), data, data + take);
    return take;
  }
};

int main() {
  std::vector<uint8_t> jpeg(6263);
  for (size_t i = 0; i < jpeg.size(); ++i) jpeg[i] = static_cast<uint8_t>(i);
  const auto original = jpeg;
  for (size_t fragment : {size_t(512), size_t(73), size_t(1)}) {
    FakeClient client; client.maxWrite = fragment;
    uint32_t clock = 0;
    auto result = writeJpegBody(client, jpeg.data(), jpeg.size(), [&]() { return clock; }, [&]() { ++clock; }, 10000);
    assert(result.complete && result.queuedBytes == jpeg.size());
    assert(client.received == jpeg && jpeg == original);
  }
  {
    FakeClient client; client.maxWrite = 0;
    uint32_t clock = 0;
    auto result = writeJpegBody(client, jpeg.data(), jpeg.size(), [&]() { return clock; }, [&]() { ++clock; });
    assert(!result.complete && result.queuedBytes == 0 && client.writes.size() == 1);
  }
  {
    FakeClient client; client.online = false;
    auto result = writeJpegBody(client, jpeg.data(), jpeg.size(), []() { return uint32_t(0); }, []() {});
    assert(!result.complete && client.writes.empty());
  }
  {
    FakeClient client;
    uint32_t clock = UINT32_MAX - 1;
    auto result = writeJpegBody(client, jpeg.data(), jpeg.size(), [&]() { return clock; }, [&]() { ++clock; }, 3);
    assert(!result.complete && result.elapsedMs == 3 && result.queuedBytes == 1536);
    assert(std::equal(client.received.begin(), client.received.end(), jpeg.begin()));
  }
  return 0;
}
