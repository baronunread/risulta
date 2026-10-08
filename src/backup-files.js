// These file operations are compiled into the standalone binary. SQLite
// supplies the integrity-checked snapshot; publication and retention stay local.
// oxlint-disable-next-line no-unused-vars -- parameters are read by inline C.
function fileAction(action, path) {
  let result = "error";
  // oxlint-disable-next-line no-unused-expressions -- inline C is consumed by Porffor.
  Porffor.c`
    const char* p; size_t pl; char* po = 0;
    porf_native_fetch_read_value(path, &p, &pl, &po);
    char* file = (char*)malloc(pl + 1); memcpy(file, p, pl); file[pl] = 0;
    if (po) free(po);
    const char* a; size_t al; char* ao = 0;
    porf_native_fetch_read_value(action, &a, &al, &ao);
    struct stat info;
    const char* status = "error";
    int found = lstat(file, &info);
    if (al == 7 && memcmp(a, "publish", 7) == 0) {
      if (found == 0 && S_ISREG(info.st_mode) && pl > 8 && strcmp(file + pl - 8, ".partial") == 0) {
        int fd = open(file, O_RDONLY | O_NOFOLLOW);
        if (fd >= 0) {
          int synced = fchmod(fd, 0600) == 0 && fsync(fd) == 0;
          close(fd);
          if (synced) {
            char* destination = strdup(file); destination[pl - 8] = 0;
            if (rename(file, destination) == 0) {
              char* slash = strrchr(destination, '/');
              if (slash) *slash = 0;
              int directory = open(destination, O_RDONLY);
              if (directory >= 0) {
                if (fsync(directory) == 0) status = "ok";
                close(directory);
              }
            }
            free(destination);
          }
        }
      }
    } else if (al == 6 && memcmp(a, "remove", 6) == 0) {
      if (found < 0 && errno == ENOENT) status = "ok";
      else if (found == 0 && S_ISREG(info.st_mode) && unlink(file) == 0) status = "ok";
    }
    if (ao) free(ao);
    free(file);
    result = porf_box((f64)porf_native_fetch_alloc_bytestring(status, strlen(status)), 195);
  `;
  return result === "ok";
}

export const backupFiles = {
  publish(path) {
    if (!fileAction("publish", path)) throw new Error("Unable to publish the backup snapshot.");
  },
  remove(path) { return fileAction("remove", path); },
};
