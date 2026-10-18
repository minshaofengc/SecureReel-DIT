// SPDX-License-Identifier: GPL-3.0-only
#import <Foundation/Foundation.h>
@interface SRStore : NSObject
@property(nonatomic,readonly) NSURL *directory;
- (NSArray<NSDictionary*>*)documents:(NSString*)kind;
- (void)put:(NSDictionary*)document kind:(NSString*)kind identifier:(NSString*)identifier;
- (void)removeKind:(NSString*)kind identifier:(NSString*)identifier;
@end
NSString *SRJSON(id object);
id SRParse(NSString *json);
NSString *SRIdentifier(NSString *prefix);
