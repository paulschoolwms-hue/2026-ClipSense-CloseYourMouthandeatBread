#pragma once
#include <string.h>

enum class CameraProfile { Current, Stable, Balanced, Detail };
struct CameraProfileSpec { int width; int height; int jpegQuality; const char* name; };
inline CameraProfileSpec cameraProfileSpec(CameraProfile profile) {
  switch (profile) {
    case CameraProfile::Balanced: return {640, 480, 18, "balanced"};
    case CameraProfile::Detail: return {640, 480, 12, "detail"};
    default: return {320, 240, 12, "stable"};
  }
}
inline bool parseCameraProfile(const char* value, CameraProfile& profile) {
  if (strcmp(value, "stable") == 0) profile = CameraProfile::Stable;
  else if (strcmp(value, "balanced") == 0) profile = CameraProfile::Balanced;
  else if (strcmp(value, "detail") == 0) profile = CameraProfile::Detail;
  else return false;
  return true;
}
