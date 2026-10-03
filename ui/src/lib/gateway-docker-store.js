import { createApi } from './api.js'
import { createGatewayDocker } from './gateway-docker.js'

// Machine-wide: always this computer's server, whatever page is open.
export const gatewayDocker = createGatewayDocker(createApi('local'))
