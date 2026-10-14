#include <errno.h>
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
    int initialized = 0;
    int roots_supported = 0;
    int client_capabilities_empty = 0;
    long last_request_id = 0;
    int subscriptions = 0;
    int unsubscriptions = 0;
    int subscribed = 0;
    while (getline(&line, &capacity, stdin) != -1) {
        if (strstr(line, "\"method\":\"initialize\"")) {
            initialization_count++;
            roots_supported = strstr(line, "\"roots\":") != NULL;
            client_capabilities_empty = strstr(line, "\"capabilities\":{}") != NULL;
        }
        if (strstr(line, "\"method\":\"notifications/initialized\"")) {
            initialized = initialization_count == 1;
            continue;
        }
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
        if (access(".sail/strict-provider-ids", F_OK) == 0 && value <= last_request_id) {
            printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"error\":{\"code\":-32600,"
                   "\"message\":\"Provider request ID was reused\"}}\n", value);
            fflush(stdout);
            continue;
        }
        last_request_id = value;
        if (strstr(line, "\"method\":\"initialize\"")) {
            FILE *mode = fopen(".sail/initialize-response", "r");
            if (mode) {
                char response[16] = {0};
                int read = fscanf(mode, "%15s", response);
                fclose(mode);
                if (read != 1) return 1;
                if (strcmp(response, "both") == 0) {
                    printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{"
                           "\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},"
                           "\"serverInfo\":{\"name\":\"fixture\",\"version\":\"1\"}},"
                           "\"error\":{\"code\":-32603,\"message\":\"startup failed\"}}\n", value);
                } else if (strcmp(response, "neither") == 0) {
                    printf("{\"jsonrpc\":\"2.0\",\"id\":%ld}\n", value);
                } else if (strcmp(response, "error") == 0) {
                    printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"error\":{"
                           "\"code\":-32603,\"message\":\"startup failed\"}}\n", value);
                } else {
                    return 1;
                }
                fflush(stdout);
                continue;
            }
        }
        char *progress_token = strstr(line, "\"progressToken\"");
        long progress_id = progress_token && (progress_token = strchr(progress_token, ':'))
            ? strtol(progress_token + 1, NULL, 10) : 0;
        if (strstr(line, "\"method\":\"resources/subscribe\"")) {
            subscriptions++;
            subscribed = 1;
        }
        if (strstr(line, "\"method\":\"resources/unsubscribe\"")) {
            unsubscriptions++;
            subscribed = 0;
        }
        if (strstr(line, "\"method\":\"resources/subscribe\"") ||
            strstr(line, "\"method\":\"resources/unsubscribe\"")) {
            if (access(".sail/hold-resource-subscriptions", F_OK) == 0) {
                char marker[64];
                snprintf(marker, sizeof(marker), "subscription-ready-%ld", (long)getpid());
                if (!write_marker(marker)) return 1;
                while (access(".sail/release-resource-subscriptions", F_OK) != 0) {
                    usleep(10000);
                }
            }
            if (access(".sail/slow-resource-subscriptions", F_OK) == 0) {
                usleep(750000);
            }
        }
        if (strstr(line, "\"method\":\"invalid-slow\"")) {
            if (!write_marker("protocol-fault-ready")) return 1;
            sleep(1);
            puts("invalid provider response");
            fflush(stdout);
            continue;
        }
        int tool_call = strstr(line, "\"method\":\"tools/call\"") != NULL;
        if (tool_call && strstr(line, "\"name\":\"get\"")) {
            printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"content\":\"", value);
            for (size_t index = 0; index < 2 * 1024 * 1024; index++) putchar('x');
            puts("\"}}");
            fflush(stdout);
            continue;
        }
        int tools_changed = tool_call && strstr(line, "\"name\":\"fixture_tools_changed\"");
        if (tool_call && roots_supported) {
            puts("{\"jsonrpc\":\"2.0\",\"id\":884,\"method\":\"roots/list\"}");
            fflush(stdout);
            if (getline(&line, &capacity, stdin) == -1 || !strstr(line, "\"result\"")) return 1;
        }
        if (tools_changed) {
            puts("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}");
            fflush(stdout);
        }
        int idle_progress = strstr(line, "\"method\":\"idle-many-progress\"") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_idle_progress\""));
        int idle_ping = strstr(line, "\"method\":\"idle-ping\"") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_idle_ping\"")) || idle_progress;
        int progress = strstr(line, "\"method\":\"many-progress\"") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_many_progress\""));
        if (access(".sail/strict-provider-lifecycle", F_OK) == 0 &&
            (tool_call || strstr(line, "\"method\":\"tools/list\"")) &&
            (!initialized || initialization_count != 1)) {
            fputs("provider requires initialize and notifications/initialized before tools\n", stderr);
            return 1;
        }
        int cancelled = strstr(line, "\"method\":\"wait-for-cancel\"") != NULL ||
            strstr(line, "\"method\":\"wait-for-cancel-no-response\"") != NULL ||
            strstr(line, "\"method\":\"wait-for-cancel-late-progress\"") != NULL ||
            (tool_call && (strstr(line, "\"name\":\"fixture_wait_cancel\"") ||
                          strstr(line, "\"name\":\"fixture_wait_cancel_no_response\"") ||
                          strstr(line, "\"name\":\"fixture_wait_cancel_late_progress\"")));
        int late_progress_cancel = strstr(line, "wait-for-cancel-late-progress") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_wait_cancel_late_progress\""));
        int no_response_cancel = strstr(line, "wait-for-cancel-no-response") != NULL ||
            (tool_call && strstr(line, "\"name\":\"fixture_wait_cancel_no_response\"")) ||
            late_progress_cancel;
        int idle_resource = subscribed && tool_call && strstr(line, "\"name\":\"fixture_idle_resource_updated\"");
        if (subscribed && tool_call && strstr(line, "\"name\":\"fixture_resource_updated\"")) {
            puts("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/resources/updated\","
                 "\"params\":{\"uri\":\"fixture://shared\"}}");
            fflush(stdout);
        }
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
            char expected[64];
            snprintf(expected, sizeof(expected), "\"requestId\":%ld", value);
            if (!strstr(line, expected)) return 1;
            if (!write_marker("cancellation-received")) return 1;
            if (late_progress_cancel) {
                printf("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\","
                       "\"params\":{\"progressToken\":%ld,\"progress\":999}}\n", progress_id);
                fflush(stdout);
            }
            if (no_response_cancel) continue;
        }
        if (progress) {
            for (int count = 0; count < 160; count++) {
                printf("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\","
                       "\"params\":{\"progressToken\":%ld,\"progress\":%d,\"total\":160}}\n", progress_id, count);
                fflush(stdout);
            }
        }
        const char *result = "";
        if (cancelled) {
            result = strstr(line, "\"reason\":\"owner\"")
                ? ",\"cancelled\":true,\"cancelledBy\":\"owner\",\"content\":[{\"type\":\"text\",\"text\":\"fixture cancelled\"}],\"isError\":false"
                : ",\"cancelled\":true,\"cancelledBy\":\"other\",\"content\":[{\"type\":\"text\",\"text\":\"fixture cancelled\"}],\"isError\":false";
        } else if (strstr(line, "\"method\":\"initialize\"")) {
            result = ",\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{},\"resources\":{\"subscribe\":true}},"
                     "\"serverInfo\":{\"name\":\"sail-fixture\",\"version\":\"1.0\"}";
        } else if (strstr(line, "\"method\":\"tools/list\"")) {
            result = ",\"tools\":[{\"name\":\"fixture_ping\",\"description\":\"Reply from the fixture\","
                     "\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_server_ping\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_idle_ping\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_idle_progress\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_many_progress\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_tools_changed\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_resource_updated\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_idle_resource_updated\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_wait_cancel_no_response\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_wait_cancel_late_progress\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
                     "{\"name\":\"fixture_wait_cancel\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]";
        } else if (tool_call) {
            result = ",\"content\":[{\"type\":\"text\",\"text\":\"fixture reply\"}],\"isError\":false";
        }
        printf("{\"jsonrpc\":\"2.0\",\"id\":%ld,\"result\":{\"pid\":%ld,\"initializeCount\":%d,"
               "\"subscriptions\":%d,\"unsubscriptions\":%d,\"subscribed\":%s,"
               "\"clientCapabilitiesEmpty\":%s%s}}\n",
               value, (long)getpid(), initialization_count,
               subscriptions, unsubscriptions, subscribed ? "true" : "false",
               client_capabilities_empty ? "true" : "false", result);
        fflush(stdout);
        if (idle_resource) {
            puts("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/resources/updated\","
                 "\"params\":{\"uri\":\"fixture://shared\"}}");
            fflush(stdout);
        }
        if (idle_progress) {
            for (int count = 0; count < 160; count++) {
                printf("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\","
                       "\"params\":{\"level\":\"info\",\"data\":%d}}\n", count);
                fflush(stdout);
            }
        }
        if (idle_ping) {
            puts("{\"jsonrpc\":\"2.0\",\"id\":999,\"method\":\"ping\"}");
            fflush(stdout);
            if (getline(&line, &capacity, stdin) == -1 ||
                !strstr(line, "\"id\":999") || !strstr(line, "\"result\":{}") ||
                strstr(line, "\"error\"")) return 1;
            if (!write_marker(idle_progress ? "idle-progress-ping-replied" : "idle-ping-replied")) return 1;
        }
        if (initialization_count && access(".sail/block-provider-stdin", F_OK) == 0) {
            if (!write_marker("blocked-input")) return 1;
            if (access(".sail/observe-provider-write", F_OK) == 0) {
                char prefix[4096];
                size_t received = 0;
                while (received < sizeof(prefix)) {
                    ssize_t count = read(STDIN_FILENO, prefix + received, sizeof(prefix) - received);
                    if (count < 0 && errno == EINTR) continue;
                    if (count <= 0) return 1;
                    received += (size_t)count;
                }
                if (!write_marker("partial-input")) return 1;
            }
            for (;;) pause();
        }
    }
    free(line);
    return 0;
}
