import fs from 'node:fs';
// Local development only. Source root must be the private read-only p2 snapshot.
// node gen_x_poko_cases.mjs /tmp/x-poko-reference /tmp/x-poko-pure.json
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = name => import(pathToFileURL(path.join(process.argv[2], 'src', name)));
const card = await load('poko-card-x.js');
const friend = await load('poko-truth-friend.js');
const hook = await load('poko-x-hook.js');
const x = await load('x-client.js');
const rows=[];
const add=(fn,args,result)=>rows.push({fn,args,result});
const samples=['','Hi','Base Set: Charizard is back! More here.','@fan #PokemonTCG &amp; stuff https://x.test/link', 'x'.repeat(400),'  hello\n\nworld  ','scam airdrop','Pokémon cards are nice','Pikachu '.repeat(20),'✨'.repeat(10),'"wrapped in quotes"','PT1H2M3S','PT','pt2m','P1DT2H'];
for(const value of samples) {
 for (const [name,fn] of Object.entries({clean_post_text:hook.cleanPostText,hook_snippet:hook.hookSnippet,parse_iso_duration:hook.parseIsoDuration,clamp_reply:v=>String(v).replace(/\s+/g,' ').replace(/^["'\s]+|["'\s]+$/g,'').length>260?`${String(v).replace(/\s+/g,' ').replace(/^["'\s]+|["'\s]+$/g,'').slice(0,257).trimEnd()}...`:String(v).replace(/\s+/g,' ').replace(/^["'\s]+|["'\s]+$/g,'')})) add(name,[value],fn(value));
 add('is_safe',[value,true],card.isCardPostSafe(value)); add('is_safe',[value,false],friend.isSafeForPoko(value));
 add('original_post',[value,null],card.originalPost(value)); add('friend_line',[value],friend.friendLine(value));
 add('mention_text',[value,'@truth_terminal'],friend.mentionText(value,'@truth_terminal'));
}
const tweets=[{id:'9007199254740993',text:'Charizard Base Set forever',username:'fan',public_metrics:{like_count:10}},{id:'9007199254740992',text:'Lugia card is great',username:'other',public_metrics:{like_count:10}},{id:'9007199254740994',text:'scam giveaway airdrop',username:'bad',public_metrics:{like_count:1000}}];
for(const tweet of tweets){add('engagement_score',[tweet],hook.engagementScore(tweet)); add('card_reply',[tweet],card.cardReply(tweet));add('friend_hook',[tweet],friend.friendHook(tweet));add('original_post',['2026-10-22',tweet],card.originalPost('2026-10-22',tweet));}
for(const replied of [[],['9007199254740993'],tweets.map(t=>t.id)]) {
 add('pick_tweet',[tweets,replied,'PokoinPoS'],card.pickCardTweet(tweets,replied,'PokoinPoS','2026-10-22'));
 add('pick_tweet',[tweets,replied,null],friend.pickFriendTweet(tweets,replied,'2026-10-22'));
}
for(const state of [{},{lastCommentDate:'2026-10-22'},{pendingDate:'2026-10-22',pendingTweetId:'9007199254740992'},{repliedIds:tweets.map(t=>t.id)}])add('decide_friend_action',[state,tweets,'2026-10-22'],friend.decideFriendAction(state,tweets,new Date('2026-10-22T12:00:00Z')));
for(const [title,duration] of [['#Shorts hello',200],['test',60],['test',61],['test',0]])add('is_youtube_short',[title,duration],hook.isYouTubeShort({title,durationSec:duration}));
const creds={apiKey:'consumer-key',apiSecret:'consumer-secret',accessToken:'access-token',accessTokenSecret:'access-token-secret'};
for(const url of ['https://api.x.com/2/tweets','https://api.x.com/2/tweets/search/recent?query=pokemon%20card&max_results=20','https://api.x.com/2/test?x=2&x=1&a=%21%27%28%29%2A'])add('oauth1',['POST',url],x.oauth1AuthorizationHeader('POST',url,creds,{nonce:'noncenonce',timestamp:'1700000000'}));
for(const token of ['', 'test-crc-token-123','token-a'])add('crc',[token],x.crcResponseToken(token,'consumer-secret'));
fs.writeFileSync(process.argv[3],JSON.stringify(rows,null,2)+'\n');
