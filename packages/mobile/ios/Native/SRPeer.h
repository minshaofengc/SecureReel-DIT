// SPDX-License-Identifier: GPL-3.0-only
#import <Foundation/Foundation.h>
@interface SRPeer : NSObject <NSURLSessionDelegate, NSURLSessionTaskDelegate>
- (void)pair:(NSDictionary*)setup device:(NSString*)name completion:(void(^)(NSString*,NSError*))completion;
- (NSDictionary*)info;
- (void)forget;
- (void)request:(NSString*)method path:(NSString*)path body:(NSString*)body completion:(void(^)(NSData*,NSError*))completion;
@end
