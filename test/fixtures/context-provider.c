#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char *line = NULL;
    size_t capacity = 0;
    int initialization_count = 0;
    while (getline(&line, &capacity, stdin) != -1) {
        if (strstr(line, "\"method\":\"initialize\"")) initialization_count++;
        if (strstr(line, "\"method\":\"slow\"")) {
            sleep(2);
        }
        if (strstr(line, "\"method\":\"write\"")) {
            const char *home = getenv("HOME");
            char marker[4096];
            if (!home) return 1;
            int length = snprintf(marker, sizeof(marker), "%s/written", home);
            if (length < 0 || (size_t)length >= sizeof(marker)) return 1;
            FILE *file = fopen(marker, "w");
            if (!file) return 1;
            fclose(file);
        }
        char *id = strstr(line, "\"id\"");
        if (!id || !(id = strchr(id, ':'))) continue;
        char *end = NULL;
        long value = strtol(id + 1, &end, 10);
        if (end == id + 1) continue;
        const char *result = "";
        if (strstr(line, "\"method\":\"initialize\"")) {
            result = ",\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},"
                     "\"serverInfo\":{\"name\":\"sail-fixture\",\"version\":\"1.0\"}";
        } else if (strstr(line, "\"method\":\"tools/list\"")) {
            result = ",\"tools\":[{\"name\":\"fixture_ping\",\"description\":\"Reply from the fixture\","
                     "\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]";
        } else if (strstr(line, "\"method\":\"tools/call\"")) {
            result = ",\"content\":[{\"type\":\"text\",\"text\":\"fixture reply\"}],\"isError\":false";
        }
        printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"pid\":%ld,\"initializeCount\":%d%s}}\n",
               value, (long)getpid(), initialization_count, result);
        fflush(stdout);
    }
    free(line);
    return 0;
}
