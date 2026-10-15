#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end;
  errno = 0;
  long pid = strtol(argv[1], &end, 10);
  if (errno || *end || end == argv[1] || pid <= 0 || pid > INT_MAX) return 2;
  struct rusage_info_v4 usage;
  if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
    perror("proc_pid_rusage");
    return 1;
  }
  printf("{\"appRssBytes\":%llu,\"appFootprintBytes\":%llu}\n",
         usage.ri_resident_size, usage.ri_phys_footprint);
  return 0;
}
