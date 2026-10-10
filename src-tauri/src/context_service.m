#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#import <xpc/xpc.h>

extern bool sail_context_validate_approval(const char *directory, const char *expected,
                                           char *output, size_t length);

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
    char buffer[4096] = {0};
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
                    [sessions removeObjectForKey:key];
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
                        if (!session && binding && capability) {
                            sessions[key] = @{ @"directory": directory,
                                               @"projectKey": binding[@"projectKey"],
                                               @"fingerprint": binding[@"fingerprint"],
                                               @"capability": capability };
                            xpc_dictionary_set_string(reply, "capability", capability.UTF8String);
                            xpc_dictionary_set_string(reply, "projectKey", [binding[@"projectKey"] UTF8String]);
                        } else {
                            xpc_dictionary_set_string(reply, "error", "Context approval unavailable.");
                        }
                    } else if ([op isEqualToString:@"check"]) {
                        NSString *capability = field(message, "capability");
                        NSDictionary *binding = session ? approval(session[@"directory"], session[@"fingerprint"]) : nil;
                        if (session && equalCapability(capability, session[@"capability"]) &&
                            [binding[@"projectKey"] isEqualToString:session[@"projectKey"]]) {
                            xpc_dictionary_set_bool(reply, "authorized", true);
                        } else {
                            [sessions removeObjectForKey:key];
                            xpc_dictionary_set_string(reply, "error", "Context session revoked.");
                        }
                    } else if ([op isEqualToString:@"end"]) {
                        [sessions removeObjectForKey:key];
                        xpc_dictionary_set_bool(reply, "ended", true);
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
            NSError *registrationError = nil;
            if (service.status == SMAppServiceStatusNotRegistered &&
                ![service registerAndReturnError:&registrationError]) {
                writeError(error, errorLength, registrationError.localizedDescription ?: @"Context service registration failed.");
                return NULL;
            }
            if (service.status != SMAppServiceStatusEnabled) {
                writeError(error, errorLength, @"Context service needs approval in System Settings.");
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
bool sail_context_probe_replay(const char *directory, char *error, size_t errorLength) {
    void *handle = sail_context_session_open(directory, error, errorLength);
    if (!handle) return false;
    @autoreleasepool {
        SailContextSession *session = (__bridge SailContextSession *)handle;
        xpc_connection_t other = xpc_connection_create_mach_service(serviceLabel().UTF8String, NULL, 0);
        NSString *hash = selfCodeHash();
        NSString *requirement = [NSString stringWithFormat:@"cdhash H\"%@\"", hash];
        if (!hash || xpc_connection_set_peer_code_signing_requirement(other, requirement.UTF8String) != 0) {
            writeError(error, errorLength, @"Replay probe cannot verify service signature.");
            xpc_connection_set_event_handler(other, ^(xpc_object_t ignored) { (void)ignored; });
            xpc_connection_resume(other);
            xpc_connection_cancel(other);
            sail_context_session_close(handle);
            return false;
        }
        xpc_connection_set_event_handler(other, ^(xpc_object_t ignored) { (void)ignored; });
        xpc_connection_resume(other);
        xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(request, "op", "check");
        xpc_dictionary_set_string(request, "capability", session.capability.UTF8String);
        xpc_object_t reply = xpc_connection_send_message_with_reply_sync(other, request);
        bool rejected = xpc_get_type(reply) == XPC_TYPE_DICTIONARY &&
            [senderBundlePath(reply) isEqualToString:canonicalPath(NSBundle.mainBundle.bundlePath)] &&
            !xpc_dictionary_get_bool(reply, "authorized") &&
            xpc_dictionary_get_string(reply, "error") != NULL;
        xpc_connection_cancel(other);
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
