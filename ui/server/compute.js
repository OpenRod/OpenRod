import fs from 'node:fs'
import path from 'node:path'
import { legacyHeaderPrefix, ownerLabel, workerOwnerHash } from './cloud-deployment.js'
export function workerDeploymentConfig(config, env=process.env) {
 const project=config.firebase.projectId,zone=env.OPENROD_WORKER_ZONE??'us-east1-b',subnet=env.OPENROD_WORKER_SUBNET
 const artifactOrigin=env.OPENROD_WORKER_ARTIFACT_ORIGIN,artifactHash=env.OPENROD_WORKER_ARTIFACT_SHA256
 if(!/^[a-z0-9-]+$/.test(zone)||!subnet?.startsWith(`projects/${project}/regions/`)||!/^http:\/\/10\.80\.0\.\d{1,3}:8080$/.test(artifactOrigin??'')||!/^[a-f0-9]{64}$/.test(artifactHash??''))throw Error('Worker deployment configuration is incomplete')
 const url=new URL(artifactOrigin)
 if(Number(url.hostname.split('.').at(-1))>254||Number(url.hostname.split('.').at(-1))<1)throw Error('Invalid worker artifact address')
 const region=zone.replace(/-[a-z]$/,'')
 if(!new RegExp(`^projects/${project}/regions/${region}/subnetworks/[a-z][a-z0-9-]{0,62}$`).test(subnet))throw Error('Worker subnet must belong to the configured project and zone region')
 const networkTag=env.OPENROD_WORKER_NETWORK_TAG??'openrod-user-worker',label=ownerLabel(env.OPENROD_WORKER_OWNER_LABEL)
 if(!/^[a-z][a-z0-9-]{0,62}$/.test(networkTag))throw Error('Invalid OPENROD_WORKER_NETWORK_TAG')
 return {project,zone,subnet,artifactOrigin,artifactHash,networkTag,ownerLabel:label}
}
export async function createCompute(config, credential, {env=process.env, requestFetch=fetch}={}) {
 const {project,zone,subnet,artifactOrigin,artifactHash,networkTag,ownerLabel}=workerDeploymentConfig(config,env)
 const source=fs.readFileSync(path.resolve(import.meta.dirname,'../../deploy/gcp/worker-startup.sh'),'utf8')
 const base=`https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}`
 async function request(method,url,body) {
  const token=await credential.getAccessToken()
  const response=await requestFetch(url,{method,headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)})
  if(response.status===404&&method==='GET')return null
  const value=await response.json()
  if(!response.ok || value.error){const e=Error(value.error?.message??value.error?.errors?.[0]?.message??'Compute request failed');e.code=response.status;throw e}
  return value
 }
 return {get:name=>request('GET',`${base}/instances/${name}`),async create(record){
  const settings=Buffer.from(JSON.stringify({key:record.key,uid:record.uid,origin:config.origin,artifactOrigin,artifactHash,name:record.name,workerProtocol:config.workerProtocol??'current',...(config.workerProtocol==='legacy'?{legacyHeaderPrefix:legacyHeaderPrefix(env.OPENROD_LEGACY_HEADER_PREFIX)}:{})})).toString('base64')
  const script=Buffer.from(source.replace('__OPENROD_WORKER_SETTINGS__',settings)).toString('base64')
  const startup=`#!/usr/bin/env bash
set -euo pipefail
umask 077
printf '%s' '${script}' | base64 -d > /usr/local/sbin/openrod-worker-bootstrap
chmod 700 /usr/local/sbin/openrod-worker-bootstrap
cat > /etc/systemd/system/openrod-worker-bootstrap.service <<'UNIT'
[Unit]
Description=OpenRod private worker bootstrap
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=7200
StartLimitBurst=5
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/openrod-worker-bootstrap
Restart=on-failure
RestartSec=30
TimeoutStartSec=2400
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now openrod-worker-bootstrap
`
  const body={name:record.name,machineType:`zones/${zone}/machineTypes/e2-standard-2`,labels:{application:'openrod',managed_by:'openrod-console',[ownerLabel]:workerOwnerHash(record.uid)},tags:{items:[networkTag]},serviceAccounts:[],canIpForward:false,
   disks:[{boot:true,autoDelete:true,initializeParams:{sourceImage:'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',diskSizeGb:'30',diskType:`zones/${zone}/diskTypes/pd-balanced`}},{boot:false,autoDelete:false,deviceName:'openrod-state',initializeParams:{diskName:`${record.name}-state`,diskSizeGb:'100',diskType:`zones/${zone}/diskTypes/pd-balanced`}}],
   networkInterfaces:[{subnetwork:subnet,stackType:'IPV4_ONLY'}],metadata:{items:[{key:'enable-oslogin',value:'TRUE'},{key:'block-project-ssh-keys',value:'TRUE'},{key:'disable-legacy-endpoints',value:'TRUE'},{key:'startup-script',value:startup}]},shieldedInstanceConfig:{enableSecureBoot:true,enableVtpm:true,enableIntegrityMonitoring:true}}
  try{return await request('POST',`${base}/instances?requestId=${record.requestId}`,body)}catch(error){if(error.code!==409)throw error;return request('GET',`${base}/instances/${record.name}`)}
 }}
}
