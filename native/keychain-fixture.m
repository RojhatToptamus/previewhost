#import <Foundation/Foundation.h>
#import <Security/Security.h>

// Test fixture only. Never searches for or reads credential items.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        NSString *operation = @(argv[1]);
        NSString *path = @(argv[2]);
        if (![path.lastPathComponent hasPrefix:@"previewd-test-"]) return 2;
        SecKeychainSetUserInteractionAllowed(false);
        SecKeychainRef keychain = NULL;
        OSStatus status;
        const char *password = "previewd-disposable-fixture";
        if ([operation isEqualToString:@"create"]) {
            CFArrayRef before = NULL;
            status = SecKeychainCopySearchList(&before);
            if (!status) {
                status = SecKeychainCreate(argv[2], (UInt32)strlen(password), password, false, NULL, &keychain);
                OSStatus restored = SecKeychainSetSearchList(before);
                if (!status) status = restored;
                CFArrayRef after = NULL;
                OSStatus checked = SecKeychainCopySearchList(&after);
                if (!status && (checked || !CFEqual(before, after))) status = errSecInternalComponent;
                if (after) CFRelease(after);
                CFRelease(before);
            }
        } else {
            status = SecKeychainOpen(argv[2], &keychain);
            if (!status && [operation isEqualToString:@"lock"]) status = SecKeychainLock(keychain);
            else if (!status && [operation isEqualToString:@"unlock"]) status = SecKeychainUnlock(keychain, (UInt32)strlen(password), password, true);
            else if (!status && [operation isEqualToString:@"remove"]) status = SecKeychainDelete(keychain);
            else if (!status) status = errSecParam;
        }
        if (keychain) CFRelease(keychain);
        printf("%d\n", (int)status);
        return status ? 1 : 0;
    }
}
