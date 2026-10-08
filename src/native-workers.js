export function isMaintenanceChild() {
  let result = "0";
  // oxlint-disable-next-line no-unused-expressions -- native environment access.
  Porffor.c`
    const char* flag = getenv("RISULTA_MAINTENANCE_CHILD");
    const char* value = flag && strcmp(flag, "1") == 0 ? "1" : "0";
    result = porf_box((f64)porf_native_fetch_alloc_bytestring(value, 1), 195);
  `;
  return result === "1";
}

// A maintenance child executes this same binary with fresh SQLite connections.
// fork only prepares exec: no JavaScript or inherited SQLite runs in the child.
export function startMaintenanceProcess() {
  let result = "error";
  // oxlint-disable-next-line no-unused-expressions -- native code is compiled into the executable.
  Porffor.c`
    #include <sys/wait.h>
    #include <netinet/in.h>
    extern char** environ;
    #ifdef __APPLE__
    extern int _NSGetExecutablePath(char*, uint32_t*);
    #endif
    static pid_t maintenance_pid = 0;
    const char* status = "error";
    if (maintenance_pid > 0 && waitpid(maintenance_pid, 0, WNOHANG) == 0) {
      status = "busy";
    } else {
      maintenance_pid = 0;
      char executable[4096];
      int valid = 0;
      #ifdef __APPLE__
      uint32_t size = sizeof(executable);
      valid = _NSGetExecutablePath(executable, &size) == 0;
      #else
      ssize_t size = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
      if (size > 0) { executable[size] = 0; valid = 1; }
      #endif
      char port_env[32];
      if (valid) {
        // The runtime opens a listener even for one-shot workers. Reserve a
        // loopback port so the child never takes the web server's port.
        int probe = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address; memset(&address, 0, sizeof(address));
        address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t address_size = sizeof(address);
        valid = probe >= 0 && bind(probe, (struct sockaddr*)&address, sizeof(address)) == 0 &&
          getsockname(probe, (struct sockaddr*)&address, &address_size) == 0;
        if (valid) snprintf(port_env, sizeof(port_env), "PORT=%u", (unsigned)ntohs(address.sin_port));
        if (probe >= 0) close(probe);
      }
      if (valid) {
        size_t count = 0;
        while (environ[count]) count++;
        char** child_env = (char**)malloc((count + 3) * sizeof(char*));
        size_t used = 0;
        for (size_t i = 0; i < count; i++) {
          if (strncmp(environ[i], "RISULTA_MAINTENANCE_CHILD=", 26) != 0 && strncmp(environ[i], "PORT=", 5) != 0)
            child_env[used++] = environ[i];
        }
        child_env[used++] = "RISULTA_MAINTENANCE_CHILD=1";
        child_env[used++] = port_env;
        child_env[used] = 0;
        char* args[] = { executable, 0 };
        pid_t pid = fork();
        if (pid == 0) { execve(executable, args, child_env); _exit(127); }
        if (pid > 0) { maintenance_pid = pid; status = "started"; }
        free(child_env);
      }
    }
    result = porf_box((f64)porf_native_fetch_alloc_bytestring(status, strlen(status)), 195);
  `;
  return result;
}

// oxlint-disable-next-line no-unused-vars -- code is read by inline C.
export function exitMaintenanceProcess(code) {
  // oxlint-disable-next-line no-unused-expressions -- native process exit.
  Porffor.c`
    const char* value; size_t length; char* owned = 0;
    porf_native_fetch_read_value(code, &value, &length, &owned);
    fflush(NULL);
    _exit(length == 1 && value[0] == '0' ? 0 : 1);
  `;
}
