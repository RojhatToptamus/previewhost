#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <unistd.h>

static NSDictionary *result(OSStatus status) { return @{ @"status": @(status) }; }

static NSDictionary *perform(NSDictionary *input, SecKeychainRef keychain) {
    NSString *operation = input[@"operation"];
    NSString *space = input[@"namespace"];
    NSString *account = input[@"id"];
    NSSet *operations = [NSSet setWithArray:@[@"get", @"add", @"update", @"remove"]];
    NSSet *spaces = [NSSet setWithArray:@[@"unlock"]];
    if (![operation isKindOfClass:NSString.class] || ![operations containsObject:operation]
        || ![space isKindOfClass:NSString.class] || ![spaces containsObject:space]) return result(errSecParam);
    if ((![account isKindOfClass:NSString.class] || account.length == 0 || account.length > 512
        || [account rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound)) return result(errSecParam);
    BOOL writing = [@[@"add", @"update", @"remove"] containsObject:operation];
    BOOL interactive = writing && [input[@"interactive"] isEqual:@YES];
    OSStatus status = SecKeychainSetUserInteractionAllowed(interactive);
    if (status) return result(status);
    SecKeychainStatus state = 0;
    status = SecKeychainGetStatus(keychain, &state);
    if (status) return result(status);
    if (!interactive && !(state & kSecUnlockStateStatus)) return result(errSecInteractionNotAllowed);
    NSString *service = [@"dev.previewhost." stringByAppendingString:space];
    NSMutableDictionary *query = [@{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service, (__bridge id)kSecMatchSearchList: @[(__bridge id)keychain] } mutableCopy];
    query[(__bridge id)kSecAttrAccount] = account;
    if ([operation isEqualToString:@"remove"]) return result(SecItemDelete((__bridge CFDictionaryRef)query));
    if ([operation isEqualToString:@"add"] || [operation isEqualToString:@"update"]) {
        NSString *value = input[@"data"];
        if (![value isKindOfClass:NSString.class]) return result(errSecParam);
        NSData *bytes = [[NSData alloc] initWithBase64EncodedString:value options:0];
        if (!bytes || bytes.length == 0 || bytes.length > 4096 || memchr(bytes.bytes, 0, bytes.length)) return result(errSecParam);
        NSString *valid = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
        if (!valid) return result(errSecParam);
        NSDictionary *update = @{ (__bridge id)kSecValueData: bytes };
        if ([operation isEqualToString:@"update"]) return result(SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)update));
        [query removeObjectForKey:(__bridge id)kSecMatchSearchList];
        query[(__bridge id)kSecUseKeychain] = (__bridge id)keychain;
        query[(__bridge id)kSecValueData] = bytes;
        query[(__bridge id)kSecAttrLabel] = [@"previewhost: " stringByAppendingString:account];
        return result(SecItemAdd((__bridge CFDictionaryRef)query, NULL));
    }
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef found = NULL;
    status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    id value = CFBridgingRelease(found);
    if (status) return result(status);
    if (![value isKindOfClass:NSData.class] || [value length] != 64) return result(errSecDecode);
    return @{ @"status": @0, @"data": [value base64EncodedStringWithOptions:0] };
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDictionary *output = result(errSecParam);
        @try {
            // One bounded request per process; neither values nor replies enter argv.
            unsigned char buffer[32769];
            size_t length = 0;
            ssize_t size;
            while (length < sizeof(buffer) && (size = read(STDIN_FILENO, buffer + length, sizeof(buffer) - length)) > 0) length += size;
            if (length <= 32768) {
                id input = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:buffer length:length] options:0 error:NULL];
                if ([input isKindOfClass:NSDictionary.class]) {
                    SecKeychainRef keychain = NULL;
                    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
#ifdef PREVIEWHOST_KEYCHAIN_TEST
                    if (!status && argc == 2) status = SecKeychainOpen(argv[1], &keychain);
                    else if (!status) status = errSecParam;
#else
                    (void)argv;
                    if (!status && argc == 1) status = SecKeychainCopyDefault(&keychain);
                    else if (!status) status = errSecParam;
#endif
                    output = status ? result(status) : perform(input, keychain);
                    if (keychain) CFRelease(keychain);
                }
            }
            for (volatile unsigned char *byte = buffer; byte < buffer + sizeof(buffer); byte++) *byte = 0;
        } @catch (NSException *exception) {
            (void)exception;
            output = result(errSecInternalComponent);
        }
        NSData *bytes = [NSJSONSerialization dataWithJSONObject:output options:0 error:NULL];
        if (!bytes) return 1;
        fwrite(bytes.bytes, 1, bytes.length, stdout);
        fputc('\n', stdout);
    }
    return 0;
}
