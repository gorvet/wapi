import { isSessionExists, isSessionConnected, getSessionIssue } from '../whatsapp.js'
import response from './../response.js'

const validate = (req, res, next) => {
    const sessionId = req.query.id ?? req.params.id

    if (!isSessionExists(sessionId)) {
        const issue = getSessionIssue(sessionId)
        // Fork guard: surface the last mismatch briefly so clients do not see an ambiguous 404.
        if (issue && req.baseUrl === '/sessions' && (req.path.startsWith('/status/') || req.path.startsWith('/find/'))) {
            return response(res, 409, false, issue.message, issue)
        }

        return response(res, 404, false, 'Session not found.')
    }

    if (req.baseUrl !== '/sessions' && !isSessionConnected(sessionId)) {
        return response(res, 400, false, 'There is no connection with whatsapp at the moment, please try again')
    }

    res.locals.sessionId = sessionId
    next()
}

export default validate
