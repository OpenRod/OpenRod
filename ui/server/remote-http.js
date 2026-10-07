export const responseJson=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export const remoteFail=(message,status=400)=>Object.assign(Error(message),{status})
export async function readJson(req,max=16000){
 if(req.headers['content-type']!=='application/json'||req.headers['x-openshell-console']!=='1')throw remoteFail('Request rejected',403)
 let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>max)throw remoteFail('Request too large',413)}
 try{return JSON.parse(body)}catch{throw remoteFail('Invalid JSON')}
}
export function safeWorkspaceTarget(target,prefix){
 if(typeof target!=='string'||!target.startsWith(prefix+'/'))throw remoteFail('Invalid remote target',404)
 const suffix=target.slice(prefix.length),path=suffix.split('?')[0]
 if(/%2f|%5c|%2e|\\|\/\//i.test(path)||path.split('/').some(p=>p==='.'||p==='..'))throw remoteFail('Invalid remote target')
 if(!/^\/(capabilities|resource-imports|context|inventory|overview|sandboxes|activity|activity-destinations|setups|cloud-export|cloud-import|cloud-transfer|policy|settings|secrets|profiles|templates|image-templates|org|egress|files|downloads|ingress|stream|editors|local-folder|terminal|ssh)(?:\/|$)/.test(path))throw remoteFail('Unknown remote operation',404)
 return '/api/os'+suffix
}
