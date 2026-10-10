import * as React from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/notice"
import { useCompute } from "@/lib/compute"

// Follows an OpenRod Cloud sign-in and machine setup after its location
// dialog closes, like sandbox creations do.
export function CloudSetupNotice() {
  const compute = useCompute()
  const setup = compute?.cloudSetup
  if (!setup || compute.cloudSetupWatched) return null
  const props = setup.stage === "signing-in" ? { tone: "progress", title: "Signing in to OpenRod Cloud…", body: "Complete sign-in in the new window.", actions: <Button size="xs" variant="ghost" onClick={compute.cancelCloudSetup}>Cancel</Button> }
    : setup.stage === "preparing" ? { tone: "progress", title: "Setting up your cloud machine…", body: "High demand may slow this down.", actions: <Button size="xs" variant="ghost" onClick={compute.cancelCloudSetup}>Cancel</Button> }
    : setup.stage === "ready" ? { tone: "success", title: "OpenRod Cloud is ready", body: "Choose OpenRod Cloud as the location to use it.", dismiss: true }
    : { tone: "error", title: "Couldn’t set up OpenRod Cloud", body: setup.error, actions: <Button size="xs" variant="outline" onClick={compute.startCloudSetup}>Try again</Button>, dismiss: true }
  return <Notice id="cloud-setup" tone={props.tone} title={props.title} actions={props.actions}
    onDismiss={props.dismiss ? compute.dismissCloudSetup : undefined} dismissLabel="Dismiss cloud setup status">{props.body}</Notice>
}
