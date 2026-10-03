// Serve the production frontend only. Tests intercept every API request;
// no gateway, operator state, or credentials are used by this server.
import http from 'node:http'
import connect from 'connect'
import serveStatic from 'serve-static'
const app = connect().use(serveStatic('dist'))
http.createServer(app).listen(Number(process.argv[2]), '127.0.0.1')
