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
        if (strstr(line, "\"name\":\"search\"")) {
            char *requested = strstr(line, "\"limit\":");
            long limit = requested ? strtol(requested + strlen("\"limit\":"), NULL, 10) : 0;
            if (strstr(line, "ignore-limit")) limit = 8;
            if (limit < 1 || limit > 8) return 1;
            char content[8192];
            memset(content, 'x', sizeof(content));
            printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"structuredContent\":{\"items\":[", value);
            for (long item = 0; item < limit; item++) {
                if (item) putchar(',');
                printf("{\"id\":\"hit-%ld\",\"sourceUri\":\"file:///search\",\"revision\":\"r1\",\"timestampMs\":1760122800000,\"content\":\"", item);
                if (strstr(line, "escaped")) {
                    for (size_t index = 0; index < 8 * 1024 * 1024 / 1024; index++) {
                        for (size_t chunk = 0; chunk < 1024; chunk++) fputs("\\u0000", stdout);
                    }
                } else {
                    for (size_t index = 0; index < 8 * 1024 * 1024 / sizeof(content); index++) {
                        fwrite(content, 1, sizeof(content), stdout);
                    }
                }
                putchar('"');
                putchar('}');
            }
            puts("]}}}");
            fflush(stdout);
            continue;
        }
        if (strstr(line, "\"name\":\"get\"")) {
            printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"content\":\"", value);
            for (size_t index = 0; index < 2 * 1024 * 1024; index++) putchar('x');
            puts("\"}}");
            fflush(stdout);
            continue;
        }
        printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"pid\":%ld,\"initializeCount\":%d}}\n",
               value, (long)getpid(), initialization_count);
        fflush(stdout);
    }
    free(line);
    return 0;
}
