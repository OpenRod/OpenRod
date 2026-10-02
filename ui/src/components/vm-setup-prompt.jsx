import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Provider-agnostic: the agent picks the cloud from the CLIs the user is
// signed into and asks first. The reply format mirrors the Add SSH fields.
export const VM_SETUP_PROMPT = `Create a Linux VM I can connect to OpenRod (a sandbox console) over SSH.
Use the cloud provider or server I already use: check which CLIs I'm logged into (aws, gcloud, az, doctl, hcloud, …). If it's unclear, ask me before creating anything.

Requirements:
- Ubuntu 22.04/24.04 LTS (or Debian 12), amd64 or arm64. A full VM, not a container.
- At least 2 vCPU, 4 GB RAM, 30 GB disk.
- SSH with key-based login only (ed25519). Use my existing key, or generate a new key pair on my machine without a passphrase (or add it to ssh-agent with ssh-add). Password login is not supported.
- A non-root user with that key in ~/.ssh/authorized_keys.
- Docker Engine (rootful, the docker.io or docker-ce package), running and enabled. Not Docker Desktop, not rootless.
- Add that user to the docker group, so \`docker ps\` works without sudo.
- Python 3 installed.
- In sshd_config: AllowTcpForwarding yes and AllowStreamLocalForwarding yes, then restart sshd.
- Open the SSH port (22 or a custom one) to my IP in the firewall/security group.

Verify, from my machine: \`ssh <user>@<host> 'docker ps && python3 --version'\` succeeds with no password prompt.

When you're done, reply with ONLY this, nothing else:

- Display name: <short name for the VM>
- Hostname: <user>@<public IP or DNS>
- SSH port: <port, or 22>
- Authentication: "SSH agent / default keys" if the key is ~/.ssh/id_ed25519 or ~/.ssh/id_rsa, or is loaded in ssh-agent. Otherwise "Key file: <full path to the PRIVATE key on my machine, e.g. ~/.ssh/openrod-vm — not the .pub>"
- Host key fingerprint (ED25519): <output of \`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\` on the VM>
`

// Some embedded browsers deny the async clipboard; fall back to a selection
// copy. The textarea goes next to the button so a dialog's focus trap allows it.
async function writeClipboard(text, anchor) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true })
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none"
  anchor.parentElement.append(area)
  area.select()
  try { return document.execCommand("copy") } catch { return false } finally { area.remove(); anchor.focus() }
}

const swap = { initial: { opacity: 0, scale: 0.6, filter: "blur(2px)" }, animate: { opacity: 1, scale: 1, filter: "blur(0px)" }, exit: { opacity: 0, scale: 0.6, filter: "blur(2px)" } }

export function VmSetupPromptButton({ className }) {
  const [copied, setCopied] = React.useState(false)
  const reduce = useReducedMotion()
  React.useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer) }, [copied])
  const copy = async (event) => {
    if (await writeClipboard(VM_SETUP_PROMPT, event.currentTarget)) setCopied(true)
    else toast.error("Couldn’t copy the prompt", { description: "Your browser blocked clipboard access." })
  }
  const motionProps = reduce ? {} : { ...swap, transition: { duration: 0.18, ease: "easeOut" } }

  return <TooltipProvider delay={300}><Tooltip>
    <TooltipTrigger render={<Button type="button" variant="outline" size="sm" onClick={copy}
      aria-label={copied ? "Prompt copied" : "Copy a VM setup prompt for your AI agent"}
      className={cn("h-8 gap-1.5 px-3 text-xs", className)} />}>
      <span className="relative grid size-3.5 place-items-center" aria-hidden="true">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={copied ? "check" : "copy"} className="grid place-items-center" {...motionProps}>
            {copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
          </motion.span>
        </AnimatePresence>
      </span>
      <AnimatePresence initial={false} mode="wait">
        <motion.span key={copied ? "copied" : "idle"} {...(reduce ? {} : { initial: { opacity: 0, y: 3 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -3 }, transition: { duration: 0.15 } })}>
          {copied
            ? <span className="text-foreground">Copied — paste into your agent</span>
            : <AnimatedShinyText className="mx-0 text-inherit motion-reduce:animate-none dark:text-inherit">Need a VM? Copy agent prompt</AnimatedShinyText>}
        </motion.span>
      </AnimatePresence>
      <span role="status" className="sr-only">{copied ? "VM setup prompt copied to clipboard" : ""}</span>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-64">Copies a prompt your AI agent can use to create a VM on any cloud provider or server, then tells you what to enter here.</TooltipContent>
  </Tooltip></TooltipProvider>
}
