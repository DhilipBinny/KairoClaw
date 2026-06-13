import { createStreamingRedactor, filterOutput } from './dist/output.js';
const SECRETS=['agw_sk_'+'a'.repeat(64),'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345','ant-ABCDEFGHIJKLMNOPQRSTUVWX','Bearer abcdefghijklmnopqrstuvwxyz0123','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV','postgres://user:pass@host:5432/db','access_token=abcdefghijklmnopqrstuvwxyz','AKIAIOSFODNN7EXAMPLE','AIza'+'A'.repeat(35),'ghp_'+'B'.repeat(36),'gho_'+'C'.repeat(36),'ghs_'+'D'.repeat(36),'github_pat_'+'E'.repeat(30),'xoxb-1234567890-abcdefghij','sk_live_'+'F'.repeat(24),'pk_live_'+'G'.repeat(24),'123456789:AAHfakeTokenABCDEFGHIJKLMNOPQRSTUVW','BSA1234567890abcdefABCDEF_xyz','AGW_MASTER_KEY=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==','-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ'+'A'.repeat(100)+'\n-----END PRIVATE KEY-----','password=hunter2hunter2','client_secret=abcdefgh12345'];
const VOCAB=['hello ','world ','eyJ','.','..','_','-',' ','\n','\t','A'.repeat(40),'A'.repeat(300),'token=','secret ','Bearer ','sk-','AKIA','AIza','ghp_','-----BEGIN PRIVATE KEY-----','-----END PRIVATE KEY-----','123456789:',':','=','"',"'",'master_key','AGW_MASTER_KEY','eyJhbGciOiJIUzI1NiJ9','postgres://','xoxb-',...SECRETS];
function lcg(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1103515245)+12345)&0x7fffffff;return s/0x7fffffff;};}
function streamFixed(text,size){const out=[];const r=createStreamingRedactor(c=>out.push(c));for(let i=0;i<text.length;i+=size)r.push(text.slice(i,i+size));r.flush();return out.join('');}
const rnd=lcg(0xBADF00D);const sizes=[1,2,3,5,7,13,64,200,1000,8191,8192,8193];
const NEEDLE='MIIEvQIBADANBgkqhkiG9w0BAQ';
for(let it=0;it<80000;it++){
  let text='';const words=1+Math.floor(rnd()*30);
  for(let w=0;w<words;w++)text+=VOCAB[Math.floor(rnd()*VOCAB.length)];
  if(rnd()<0.25){const pad=9000+Math.floor(rnd()*4000);while(text.length<pad)text+=' word '+VOCAB[Math.floor(rnd()*5)];}
  const filtered=filterOutput(text);const size=sizes[Math.floor(rnd()*sizes.length)];
  if(!text.includes(NEEDLE)||filtered.includes(NEEDLE))continue;
  const o=streamFixed(text,size);
  if(o.includes(NEEDLE)){
    console.log('CAPTURED size',size,'len',text.length);
    console.log(JSON.stringify(text));
    break;
  }
}
