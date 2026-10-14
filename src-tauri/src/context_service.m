#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#import <xpc/xpc.h>

extern bool sail_context_validate_approval(const char *directory, const char *expected,
                                           char *output, size_t length);
extern bool sail_context_provider_request(const char *directory, const char *expected,
                                          const char *capability, const char *request,
                                          bool (*notify)(void *, const char *), void *notifyContext,
                                          char *output, size_t length);
extern bool sail_context_provider_notifications(const char *projectKey, const char *expected,
                                                const char *capability, char *output, size_t length);
extern void sail_context_provider_stop(const char *projectKey);
extern void sail_context_provider_stop_if_fingerprint(const char *projectKey, const char *expected);
extern bool sail_context_session_activate(const char *capability);
extern void sail_context_session_deactivate(const char *capability);

typedef bool (^SailContextNotification)(NSString *);

static bool deliverNotification(void *context, const char *message) {
    @autoreleasepool {
        SailContextNotification notify = (__bridge SailContextNotification)context;
        NSString *text = message ? [NSString stringWithUTF8String:message] : nil;
        return text && notify(text);
    }
}

static void closeSession(NSMutableDictionary<NSValue *, NSDictionary *> *sessions, NSValue *key) {
    NSDictionary *session = sessions[key];
    NSString *capability = session[@"capability"];
    if (capability) sail_context_session_deactivate(capability.UTF8String);
    [sessions removeObjectForKey:key];
    NSString *projectKey = session[@"projectKey"];
    if (!projectKey) return;
    for (NSDictionary *other in sessions.allValues) {
        if ([other[@"projectKey"] isEqualToString:projectKey]) return;
    }
    sail_context_provider_stop(projectKey.UTF8String);
}

static void stopInvalidatedProvider(NSDictionary *session, NSDictionary *binding) {
    NSString *projectKey = session[@"projectKey"];
    NSString *fingerprint = session[@"fingerprint"];
    if (projectKey && fingerprint && ![binding[@"projectKey"] isEqualToString:projectKey]) {
        sail_context_provider_stop_if_fingerprint(projectKey.UTF8String, fingerprint.UTF8String);
    }
}

static bool sharedNotification(NSString *text) {
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    id value = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) return false;
    NSString *method = value[@"method"];
    if (![method isKindOfClass:NSString.class]) return false;
    return [@[@"notifications/tools/list_changed", @"notifications/resources/list_changed",
              @"notifications/prompts/list_changed", @"notifications/resources/updated"] containsObject:method];
}

static bool enqueueNotification(NSMutableDictionary<NSValue *, NSDictionary *> *sessions,
                                NSValue *key, NSDictionary *session, NSString *text, bool shared) {
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    id value = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
    NSString *resource = nil;
    if ([value isKindOfClass:NSDictionary.class] &&
        [value[@"method"] isEqual:@"notifications/resources/updated"]) {
        id params = value[@"params"];
        id uri = [params isKindOfClass:NSDictionary.class] ? params[@"uri"] : nil;
        if (![uri isKindOfClass:NSString.class]) return sessions[key] == session;
        resource = uri;
    }
    for (NSValue *otherKey in sessions.allKeys) {
        NSDictionary *other = sessions[otherKey];
        if ((!shared && ![otherKey isEqual:key]) ||
            ![other[@"projectKey"] isEqualToString:session[@"projectKey"]] ||
            ![other[@"fingerprint"] isEqualToString:session[@"fingerprint"]] ||
            (resource && ![other[@"subscriptions"] containsObject:resource])) continue;
        NSMutableString *pending = other[@"notifications"];
        if ([pending lengthOfBytesUsingEncoding:NSUTF8StringEncoding] +
            [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 1024 * 1024) {
            [pending appendString:text];
        } else {
            closeSession(sessions, otherKey);
        }
    }
    return sessions[key] == session;
}

static NSString *serviceLabel(void) {
#ifdef SAIL_CONTEXT_E2E
    NSString *identifier = NSBundle.mainBundle.bundleIdentifier;
    if (identifier.length) return [identifier stringByAppendingString:@".context-supervisor"];
#endif
    return @"dev.smykla.sai-harness.context-supervisor";
}

static NSString *servicePlist(void) {
    return [serviceLabel() stringByAppendingString:@".plist"];
}

static void writeError(char *buffer, size_t length, NSString *message) {
    if (buffer && length) {
        snprintf(buffer, length, "%s", message.UTF8String ?: "Context service unavailable.");
    }
}

static NSString *canonicalPath(NSString *path) {
    return [[NSURL fileURLWithPath:path] URLByResolvingSymlinksInPath].path;
}

static NSString *selfCodeHash(void) {
    SecCodeRef code = NULL;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    CFDictionaryRef details = NULL;
    OSStatus status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &details);
    CFRelease(code);
    if (status != errSecSuccess || !details) return nil;
    NSData *hash = [(__bridge NSDictionary *)details objectForKey:(__bridge id)kSecCodeInfoUnique];
    NSMutableString *value = [NSMutableString string];
    for (NSUInteger i = 0; i < hash.length; i++) {
        [value appendFormat:@"%02x", ((const uint8_t *)hash.bytes)[i]];
    }
    CFRelease(details);
    return value.length ? value : nil;
}

static NSString *senderBundlePath(xpc_object_t message) {
    SecCodeRef code = NULL;
    if (SecCodeCreateWithXPCMessage(message, kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    OSStatus status = SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL);
    SecStaticCodeRef disk = NULL;
    if (status == errSecSuccess) status = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &disk);
    CFRelease(code);
    if (status != errSecSuccess || !disk) return nil;
    CFURLRef url = NULL;
    status = SecCodeCopyPath(disk, kSecCSDefaultFlags, &url);
    CFRelease(disk);
    if (status != errSecSuccess || !url) return nil;
    NSString *path = canonicalPath([(__bridge NSURL *)url path]);
    CFRelease(url);
    return path;
}

static NSDictionary *approval(NSString *directory, NSString *expected) {
    char buffer[16384] = {0};
    if (!sail_context_validate_approval(directory.UTF8String, expected.UTF8String,
                                        buffer, sizeof(buffer))) return nil;
    NSData *bytes = [[NSString stringWithUTF8String:buffer] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *value = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSString *randomCapability(void) {
    uint8_t bytes[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return nil;
    NSMutableString *value = [NSMutableString stringWithCapacity:64];
    for (size_t i = 0; i < sizeof(bytes); i++) [value appendFormat:@"%02x", bytes[i]];
    return value;
}

static bool equalCapability(NSString *actual, NSString *expected) {
    NSData *a = [actual dataUsingEncoding:NSUTF8StringEncoding];
    NSData *b = [expected dataUsingEncoding:NSUTF8StringEncoding];
    if (a.length != b.length || a.length != 64) return false;
    uint8_t difference = 0;
    for (NSUInteger i = 0; i < a.length; i++) {
        difference |= ((const uint8_t *)a.bytes)[i] ^ ((const uint8_t *)b.bytes)[i];
    }
    return difference == 0;
}

static NSString *field(xpc_object_t message, const char *name) {
    const char *value = xpc_dictionary_get_string(message, name);
    return value ? [NSString stringWithUTF8String:value] : nil;
}

int sail_context_service_main(void) {
    @autoreleasepool {
        NSString *hash = selfCodeHash();
        NSString *bundle = canonicalPath(NSBundle.mainBundle.bundlePath);
        if (!hash || !bundle || ![bundle hasSuffix:@".app"]) return 64;
        dispatch_queue_t queue = dispatch_queue_create("dev.smykla.sail.context", DISPATCH_QUEUE_SERIAL);
        xpc_connection_t listener = xpc_connection_create_mach_service(serviceLabel().UTF8String, queue,
                                                                         XPC_CONNECTION_MACH_SERVICE_LISTENER);
        NSString *requirement = [NSString stringWithFormat:@"cdhash H\"%@\"", hash];
        if (xpc_connection_set_peer_code_signing_requirement(listener, requirement.UTF8String) != 0) {
            xpc_connection_set_event_handler(listener, ^(xpc_object_t ignored) { (void)ignored; });
            xpc_connection_resume(listener);
            xpc_connection_cancel(listener);
            return 65;
        }
        NSMutableDictionary<NSValue *, NSDictionary *> *sessions = [NSMutableDictionary dictionary];
        xpc_connection_set_event_handler(listener, ^(xpc_object_t peer) {
            if (xpc_get_type(peer) != XPC_TYPE_CONNECTION) return;
            if (xpc_connection_get_euid(peer) != geteuid()) {
                xpc_connection_cancel(peer);
                return;
            }
            NSValue *key = [NSValue valueWithPointer:(__bridge const void *)peer];
            xpc_connection_set_target_queue(peer, queue);
            xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
                if (xpc_get_type(message) == XPC_TYPE_ERROR) {
                    closeSession(sessions, key);
                    return;
                }
                if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return;
                xpc_object_t reply = xpc_dictionary_create_reply(message);
                if (!reply) return;
                NSString *sender = senderBundlePath(message);
                if (!sender || ![sender isEqualToString:bundle]) {
                    xpc_dictionary_set_string(reply, "error", "Sail client signature or path rejected.");
                } else {
                    NSString *op = field(message, "op");
                    NSDictionary *session = sessions[key];
                    if ([op isEqualToString:@"begin"]) {
                        NSString *directory = field(message, "directory");
                        NSDictionary *binding = directory.length <= 4096 ? approval(directory, nil) : nil;
                        NSString *capability = binding ? randomCapability() : nil;
                        if (!session && binding && capability &&
                            sail_context_session_activate(capability.UTF8String)) {
                            sessions[key] = @{ @"directory": directory,
                                               @"projectKey": binding[@"projectKey"],
                                               @"fingerprint": binding[@"fingerprint"],
                                               @"capability": capability,
                                               @"subscriptions": [NSMutableSet set],
                                               @"notifications": [NSMutableString string] };
                            xpc_dictionary_set_string(reply, "capability", capability.UTF8String);
                            xpc_dictionary_set_string(reply, "projectKey", [binding[@"projectKey"] UTF8String]);
                        } else {
                            xpc_dictionary_set_string(reply, "error", "Context approval unavailable.");
                        }
                    } else if ([op isEqualToString:@"check"]) {
                        NSString *capability = field(message, "capability");
                        NSDictionary *binding = session ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                        if (session && equalCapability(capability, session[@"capability"])) {
                            stopInvalidatedProvider(session, binding);
                        }
                        if (session && equalCapability(capability, session[@"capability"]) &&
                            [binding[@"projectKey"] isEqualToString:session[@"projectKey"]]) {
                            xpc_dictionary_set_bool(reply, "authorized", true);
                        } else {
                            closeSession(sessions, key);
                            xpc_dictionary_set_string(reply, "error", "Context session revoked.");
                        }
                    } else if ([op isEqualToString:@"notifications"]) {
                        NSString *capability = field(message, "capability");
                        NSDictionary *binding = session ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                        if (session && equalCapability(capability, session[@"capability"])) {
                            stopInvalidatedProvider(session, binding);
                        }
                        if (!session || !equalCapability(capability, session[@"capability"]) ||
                            ![binding[@"projectKey"] isEqualToString:session[@"projectKey"]]) {
                            closeSession(sessions, key);
                            xpc_dictionary_set_string(reply, "error", "Context session revoked.");
                        } else {
                            char *output = calloc(1024 * 1024 + 1, 1);
                            bool success = output && sail_context_provider_notifications(
                                [session[@"projectKey"] UTF8String],
                                [session[@"fingerprint"] UTF8String],
                                capability.UTF8String, output, 1024 * 1024 + 1);
                            NSString *text = output ? [NSString stringWithUTF8String:output] : nil;
                            free(output);
                            if (!success) {
                                xpc_dictionary_set_string(reply, "error", text.UTF8String ?: "Provider notification read failed.");
                                closeSession(sessions, key);
                                xpc_connection_send_message(peer, reply);
                                return;
                            }
                            if (text.length) {
                                for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
                                    if (line.length) enqueueNotification(sessions, key, session,
                                        [line stringByAppendingString:@"\n"], true);
                                }
                            }
                            if (sessions[key] != session) {
                                xpc_dictionary_set_string(reply, "error", "Context MCP notification queue exceeded 1 MiB.");
                                xpc_connection_send_message(peer, reply);
                                return;
                            }
                            NSMutableString *pending = session[@"notifications"];
                            xpc_dictionary_set_string(reply, "response", pending.UTF8String);
                            [pending setString:@""];
                        }
                    } else if ([op isEqualToString:@"request"]) {
                        NSString *capability = field(message, "capability");
                        NSDictionary *binding = session ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                        if (session && equalCapability(capability, session[@"capability"])) {
                            stopInvalidatedProvider(session, binding);
                        }
                        NSString *request = field(message, "request");
                        if (!session || !equalCapability(capability, session[@"capability"]) ||
                            ![binding[@"projectKey"] isEqualToString:session[@"projectKey"]] ||
                            !request || request.length > 1024 * 1024) {
                            closeSession(sessions, key);
                            xpc_dictionary_set_string(reply, "error", "Context session revoked.");
                        } else {
                            NSData *requestBytes = [request dataUsingEncoding:NSUTF8StringEncoding];
                            id parsed = [NSJSONSerialization JSONObjectWithData:requestBytes options:0 error:nil];
                            NSString *method = [parsed isKindOfClass:NSDictionary.class] ? parsed[@"method"] : nil;
                            id params = [parsed isKindOfClass:NSDictionary.class] ? parsed[@"params"] : nil;
                            id uri = [params isKindOfClass:NSDictionary.class] ? params[@"uri"] : nil;
                            NSString *resource = [uri isKindOfClass:NSString.class] ? uri : nil;
                            bool subscribing = resource && [method isEqual:@"resources/subscribe"];
                            bool unsubscribing = resource && [method isEqual:@"resources/unsubscribe"];
                            NSMutableSet *subscriptions = session[@"subscriptions"];
                            bool wasSubscribed = resource && [subscriptions containsObject:resource];
                            if (subscribing && !wasSubscribed && subscriptions.count >= 1024) {
                                xpc_dictionary_set_string(reply, "error", "Context resource subscriptions exceeded their bounded queue.");
                                xpc_connection_send_message(peer, reply);
                                return;
                            }
                            if (subscribing) [subscriptions addObject:resource];
                            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                                SailContextNotification notify = ^bool(NSString *text) {
                                    __block bool accepted = false;
                                    dispatch_sync(queue, ^{
                                        NSDictionary *latest = sessions[key] == session
                                            ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                                        if ([latest[@"projectKey"] isEqualToString:session[@"projectKey"]]) {
                                            accepted = enqueueNotification(sessions, key, session,
                                                                           text, sharedNotification(text));
                                        } else if (sessions[key] == session) {
                                            stopInvalidatedProvider(session, latest);
                                            closeSession(sessions, key);
                                        }
                                    });
                                    return accepted;
                                };
                                char *output = calloc(1024 * 1024 + 1, 1);
                                bool success = output && sail_context_provider_request(
                                    [session[@"directory"] UTF8String],
                                    [session[@"fingerprint"] UTF8String],
                                    [session[@"capability"] UTF8String], request.UTF8String,
                                    deliverNotification, (__bridge void *)notify,
                                    output, 1024 * 1024 + 1);
                                dispatch_async(queue, ^{
                                    NSString *responseText = output ? [NSString stringWithUTF8String:output] : nil;
                                    NSString *responseLine = [[responseText componentsSeparatedByString:@"\n"] lastObject];
                                    NSData *responseBytes = [responseLine dataUsingEncoding:NSUTF8StringEncoding];
                                    id response = responseBytes ? [NSJSONSerialization JSONObjectWithData:responseBytes options:0 error:nil] : nil;
                                    bool subscribed = success && [response isKindOfClass:NSDictionary.class] &&
                                        response[@"result"] && !response[@"error"];
                                    if ((subscribing && !wasSubscribed && !subscribed) || (unsubscribing && subscribed)) {
                                        [subscriptions removeObject:resource];
                                    }
                                    NSDictionary *latest = sessions[key] == session
                                        ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                                    if (![latest[@"projectKey"] isEqualToString:session[@"projectKey"]]) {
                                        if (sessions[key] == session) {
                                            stopInvalidatedProvider(session, latest);
                                            closeSession(sessions, key);
                                        }
                                        xpc_dictionary_set_string(reply, "error", "Context session revoked.");
                                    } else if (success) {
                                        xpc_dictionary_set_string(reply, "response", output);
                                    } else {
                                        xpc_dictionary_set_string(reply, "error", output && output[0]
                                            ? output : "Provider request failed.");
                                    }
                                    xpc_connection_send_message(peer, reply);
                                    free(output);
                                });
                            });
                            return;
                        }
                    } else if ([op isEqualToString:@"end"]) {
                        closeSession(sessions, key);
                        xpc_dictionary_set_bool(reply, "ended", true);
                    } else if ([op isEqualToString:@"revoke"]) {
                        NSString *projectKey = field(message, "projectKey");
                        NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
                        if (projectKey.length != 64 ||
                            [[projectKey stringByTrimmingCharactersInSet:hex] length] != 0) {
                            xpc_dictionary_set_string(reply, "error", "Invalid context project key.");
                        } else {
                            for (NSValue *sessionKey in [sessions.allKeys copy]) {
                                if ([sessions[sessionKey][@"projectKey"] isEqualToString:projectKey]) {
                                    closeSession(sessions, sessionKey);
                                }
                            }
                            sail_context_provider_stop(projectKey.UTF8String);
                            xpc_dictionary_set_bool(reply, "stopped", true);
                        }
                    } else {
                        xpc_dictionary_set_string(reply, "error", "Invalid context request.");
                    }
                }
                xpc_connection_send_message(peer, reply);
            });
            xpc_connection_resume(peer);
        });
        xpc_connection_resume(listener);
        dispatch_main();
    }
}

@interface SailContextSession : NSObject
@property(nonatomic, strong) xpc_connection_t connection;
@property(nonatomic, copy) NSString *capability;
@end
@implementation SailContextSession
@end

void *sail_context_session_open(const char *directory, char *error, size_t errorLength) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            NSString *path = directory ? [NSString stringWithUTF8String:directory] : nil;
            if (!path || ![canonicalPath(NSBundle.mainBundle.bundlePath) hasSuffix:@".app"]) {
                writeError(error, errorLength, @"Context service requires a signed Sail app bundle.");
                return NULL;
            }
            SMAppService *service = [SMAppService agentServiceWithPlistName:servicePlist()];
            SMAppServiceStatus status = service.status;
            NSError *registrationError = nil;
            if ((status == SMAppServiceStatusNotRegistered || status == SMAppServiceStatusNotFound) &&
                ![service registerAndReturnError:&registrationError]) {
                writeError(error, errorLength, registrationError.localizedDescription ?: @"Context service registration failed.");
                return NULL;
            }
            status = service.status;
            if (status != SMAppServiceStatusEnabled) {
                writeError(error, errorLength, status == SMAppServiceStatusRequiresApproval
                    ? @"Context service needs approval in System Settings."
                    : @"Context service could not be found after registration.");
                return NULL;
            }
            NSString *hash = selfCodeHash();
            if (!hash) {
                writeError(error, errorLength, @"Sail code signature unavailable.");
                return NULL;
            }
            xpc_connection_t connection = xpc_connection_create_mach_service(serviceLabel().UTF8String, NULL, 0);
            NSString *requirement = [NSString stringWithFormat:@"cdhash H\"%@\"", hash];
            if (xpc_connection_set_peer_code_signing_requirement(connection, requirement.UTF8String) != 0) {
                xpc_connection_set_event_handler(connection, ^(xpc_object_t ignored) { (void)ignored; });
                xpc_connection_resume(connection);
                xpc_connection_cancel(connection);
                writeError(error, errorLength, @"Cannot verify context service signature.");
                return NULL;
            }
            xpc_connection_set_event_handler(connection, ^(xpc_object_t ignored) { (void)ignored; });
            xpc_connection_resume(connection);
            xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
            xpc_dictionary_set_string(request, "op", "begin");
            xpc_dictionary_set_string(request, "directory", path.UTF8String);
            xpc_object_t reply = xpc_connection_send_message_with_reply_sync(connection, request);
            NSString *serverPath = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
                ? senderBundlePath(reply) : nil;
            if (![serverPath isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)]) {
                writeError(error, errorLength, @"Context service signature or path rejected.");
                xpc_connection_cancel(connection);
                return NULL;
            }
            const char *capability = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
                ? xpc_dictionary_get_string(reply, "capability") : NULL;
            if (!capability) {
                const char *reason = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
                    ? xpc_dictionary_get_string(reply, "error") : NULL;
                writeError(error, errorLength, reason ? [NSString stringWithUTF8String:reason]
                                                : @"Context service unavailable or stale after upgrade.");
                xpc_connection_cancel(connection);
                return NULL;
            }
            SailContextSession *session = [SailContextSession new];
            session.connection = connection;
            session.capability = [NSString stringWithUTF8String:capability];
            return (__bridge_retained void *)session;
        }
        writeError(error, errorLength, @"Context service requires macOS 13 or later.");
        return NULL;
    }
}

bool sail_context_provider_revoke_remote(const char *projectKey, char *error, size_t errorLength) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            if (!projectKey || strlen(projectKey) != 64) {
                writeError(error, errorLength, @"Invalid context project key.");
                return false;
            }
            SMAppService *service = [SMAppService agentServiceWithPlistName:servicePlist()];
            if (service.status != SMAppServiceStatusEnabled) return true;
            NSString *hash = selfCodeHash();
            if (!hash) {
                writeError(error, errorLength, @"Sail code signature unavailable.");
                return false;
            }
            xpc_connection_t connection = xpc_connection_create_mach_service(serviceLabel().UTF8String, NULL, 0);
            NSString *requirement = [NSString stringWithFormat:@"cdhash H\"%@\"", hash];
            if (xpc_connection_set_peer_code_signing_requirement(connection, requirement.UTF8String) != 0) {
                xpc_connection_set_event_handler(connection, ^(xpc_object_t ignored) { (void)ignored; });
                xpc_connection_resume(connection);
                xpc_connection_cancel(connection);
                writeError(error, errorLength, @"Cannot verify context service signature.");
                return false;
            }
            xpc_connection_set_event_handler(connection, ^(xpc_object_t ignored) { (void)ignored; });
            xpc_connection_resume(connection);
            xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
            xpc_dictionary_set_string(request, "op", "revoke");
            xpc_dictionary_set_string(request, "projectKey", projectKey);
            xpc_object_t reply = xpc_connection_send_message_with_reply_sync(connection, request);
            bool valid = xpc_get_type(reply) == XPC_TYPE_DICTIONARY &&
                [senderBundlePath(reply) isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)];
            bool stopped = valid && xpc_dictionary_get_bool(reply, "stopped");
            if (!stopped) {
                const char *reason = valid ? xpc_dictionary_get_string(reply, "error") : NULL;
                writeError(error, errorLength, reason ? [NSString stringWithUTF8String:reason]
                    : @"Context service signature or path rejected.");
            }
            xpc_connection_cancel(connection);
            return stopped;
        }
        writeError(error, errorLength, @"Context service requires macOS 13 or later.");
        return false;
    }
}

bool sail_context_session_check(void *handle, char *error, size_t errorLength) {
    @autoreleasepool {
        if (!handle) return false;
        SailContextSession *session = (__bridge SailContextSession *)handle;
        xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(request, "op", "check");
        xpc_dictionary_set_string(request, "capability", session.capability.UTF8String);
        xpc_object_t reply = xpc_connection_send_message_with_reply_sync(session.connection, request);
        if (![senderBundlePath(reply) isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)]) {
            writeError(error, errorLength, @"Context service signature or path rejected.");
            return false;
        }
        if (xpc_get_type(reply) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_bool(reply, "authorized")) return true;
        const char *reason = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
            ? xpc_dictionary_get_string(reply, "error") : NULL;
        writeError(error, errorLength, reason ? [NSString stringWithUTF8String:reason]
                                          : @"Context service disconnected.");
        return false;
    }
}

static bool sessionExchange(void *handle, const char *op, const char *message,
                            char *output, size_t outputLength,
                            char *error, size_t errorLength) {
    @autoreleasepool {
        if (!handle || !output || !outputLength) return false;
        SailContextSession *session = (__bridge SailContextSession *)handle;
        xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(request, "op", op);
        xpc_dictionary_set_string(request, "capability", session.capability.UTF8String);
        if (message) xpc_dictionary_set_string(request, "request", message);
        xpc_object_t reply = xpc_connection_send_message_with_reply_sync(session.connection, request);
        if (![senderBundlePath(reply) isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)]) {
            writeError(error, errorLength, @"Context service signature or path rejected.");
            return false;
        }
        const char *response = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
            ? xpc_dictionary_get_string(reply, "response") : NULL;
        if (response && strlen(response) < outputLength) {
            strlcpy(output, response, outputLength);
            return true;
        }
        const char *reason = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
            ? xpc_dictionary_get_string(reply, "error") : NULL;
        writeError(error, errorLength, reason ? [NSString stringWithUTF8String:reason]
                                          : @"Context service disconnected or response too large.");
        return false;
    }
}

bool sail_context_session_request(void *handle, const char *message,
                                  char *output, size_t outputLength,
                                  char *error, size_t errorLength) {
    return message && sessionExchange(handle, "request", message, output, outputLength, error, errorLength);
}

bool sail_context_session_notifications(void *handle, char *output, size_t outputLength,
                                        char *error, size_t errorLength) {
    return sessionExchange(handle, "notifications", NULL, output, outputLength, error, errorLength);
}

void sail_context_session_close(void *handle) {
    @autoreleasepool {
        if (!handle) return;
        SailContextSession *session = (__bridge_transfer SailContextSession *)handle;
        xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(request, "op", "end");
        xpc_connection_send_message(session.connection, request);
        xpc_connection_cancel(session.connection);
    }
}

#ifdef SAIL_CONTEXT_E2E
bool sail_context_probe_service_status(char *output, size_t length) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            NSString *bundle = canonicalPath(NSBundle.mainBundle.bundlePath);
            NSString *plist = servicePlist();
            NSString *plistPath = [bundle stringByAppendingPathComponent:
                [@"Contents/Library/LaunchAgents" stringByAppendingPathComponent:plist]];
            SMAppService *service = [SMAppService agentServiceWithPlistName:plist];
            NSDictionary *details = @{
                @"status": @(service.status),
                @"bundleIdentifier": NSBundle.mainBundle.bundleIdentifier ?: @"",
                @"label": serviceLabel(),
                @"plist": plist,
                @"plistPresent": @([NSFileManager.defaultManager fileExistsAtPath:plistPath]),
                @"helperPresent": @([NSFileManager.defaultManager fileExistsAtPath:
                    [bundle stringByAppendingPathComponent:@"Contents/MacOS/sail"]]),
            };
            NSData *json = [NSJSONSerialization dataWithJSONObject:details options:0 error:nil];
            if (!output || !json || json.length >= length) return false;
            memcpy(output, json.bytes, json.length);
            output[json.length] = '\0';
            return true;
        }
        return false;
    }
}

bool sail_context_probe_replay(const char *directory, char *error, size_t errorLength) {
    void *handle = sail_context_session_open(directory, error, errorLength);
    if (!handle) return false;
    @autoreleasepool {
        SailContextSession *session = (__bridge SailContextSession *)handle;
        bool rejected = true;
        for (NSString *operation in @[@"check", @"request"]) {
            void *otherHandle = sail_context_session_open(directory, error, errorLength);
            if (!otherHandle) {
                sail_context_session_close(handle);
                return false;
            }
            SailContextSession *other = (__bridge SailContextSession *)otherHandle;
            xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
            xpc_dictionary_set_string(request, "op", operation.UTF8String);
            xpc_dictionary_set_string(request, "capability", session.capability.UTF8String);
            if ([operation isEqualToString:@"request"]) {
                xpc_dictionary_set_string(request, "request", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
            }
            xpc_object_t reply = xpc_connection_send_message_with_reply_sync(other.connection, request);
            rejected = rejected && xpc_get_type(reply) == XPC_TYPE_DICTIONARY &&
                [senderBundlePath(reply) isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)] &&
                !xpc_dictionary_get_bool(reply, "authorized") &&
                xpc_dictionary_get_string(reply, "response") == NULL &&
                xpc_dictionary_get_string(reply, "error") != NULL;
            sail_context_session_close(otherHandle);
        }
        bool originalAuthorized = sail_context_session_check(handle, error, errorLength);
        sail_context_session_close(handle);
        if (!rejected) writeError(error, errorLength, @"Cross-connection capability replay was not rejected.");
        return rejected && originalAuthorized;
    }
}
#endif

bool sail_context_service_unregister(char *error, size_t errorLength) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            SMAppService *service = [SMAppService agentServiceWithPlistName:servicePlist()];
            if (service.status == SMAppServiceStatusNotRegistered) return true;
            NSError *failure = nil;
            if ([service unregisterAndReturnError:&failure]) return true;
            writeError(error, errorLength, failure.localizedDescription ?: @"Context service unregister failed.");
            return false;
        }
        writeError(error, errorLength, @"Context service requires macOS 13 or later.");
        return false;
    }
}
