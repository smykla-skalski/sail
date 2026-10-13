#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int write_marker(const char *name) {
    const char *home = getenv("HOME");
    char marker[4096];
    if (!home) return 0;
    int length = snprintf(marker, sizeof(marker), "%s/%s", home, name);
    if (length < 0 || (size_t)length >= sizeof(marker)) return 0;
    FILE *file = fopen(marker, "w");
    if (!file) return 0;
    return fclose(file) == 0;
}

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
            if (!write_marker("written")) return 1;
        }
        char *id = strstr(line, "\"id\"");
        if (!id || !(id = strchr(id, ':'))) continue;
        char *end = NULL;
        long value = strtol(id + 1, &end, 10);
        if (end == id + 1) continue;
        if (strstr(line, "\"method\":\"invalid-slow\"")) {
            sleep(1);
            puts("invalid provider response");
            fflush(stdout);
            continue;
        }
        int tool_call = strstr(line, "\"method\":\"tools/call\"") != NULL;
        int cancelled = strstr(line, "\"method\":\"wait-for-cancel\"") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_wait_cancel\""));
        if (strstr(line, "\"method\":\"server-ping\"") ||
            strstr(line, "\"method\":\"server-ping-different-id\"") ||
            (tool_call && strstr(line, "\"name\":\"fixture_server_ping\""))) {
            long ping_id = strstr(line, "server-ping-different-id") ? 99 : value;
            printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"method\":\"ping\"}\n", ping_id);
            fflush(stdout);
            if (getline(&line, &capacity, stdin) == -1 ||
                !strstr(line, "\"result\":{}") || strstr(line, "\"error\"")) return 1;
        }
        if (cancelled) {
            if (!write_marker("waiting")) return 1;
            puts("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\","
                 "\"params\":{\"level\":\"info\",\"data\":\"waiting for cancellation\"}}");
            fflush(stdout);
            if (getline(&line, &capacity, stdin) == -1 ||
                !strstr(line, "\"method\":\"notifications/cancelled\"")) return 1;
        }
        const char *result = "";
        if (cancelled) {
            result = strstr(line, "\"reason\":\"owner\"")
                ? ",\"cancelled\":true,\"cancelledBy\":\"owner\",\"content\":[{\"type\":\"text\",\"text\":\"fixture cancelled\"}],\"isError\":false"
                : ",\"cancelled\":true,\"cancelledBy\":\"other\",\"content\":[{\"type\":\"text\",\"text\":\"fixture cancelled\"}],\"isError\":false";
        } else if (strstr(line, "\"method\":\"initialize\"")) {
            result = ",\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},"
                     "\"serverInfo\":{\"name\":\"sail-fixture\",\"version\":\"1.0\"}";
        } else if (strstr(line, "\"method\":\"tools/list\"")) {
            result = ",\"tools\":[{\"name\":\"fixture_ping\",\"description\":\"Reply from the fixture\","
                     "\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_server_ping\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_wait_cancel\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]";
        } else if (tool_call) {
            result = ",\"content\":[{\"type\":\"text\",\"text\":\"fixture reply\"}],\"isError\":false";
        }
        printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"pid\":%ld,\"initializeCount\":%d%s}}\n",
               value, (long)getpid(), initialization_count, result);
        fflush(stdout);
        if (initialization_count && access(".sail/block-provider-stdin", F_OK) == 0) {
            if (!write_marker("blocked-input")) return 1;
            for (;;) pause();
        }
    }
    free(line);
    return 0;
}
