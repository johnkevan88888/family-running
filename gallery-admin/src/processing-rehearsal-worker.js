import { handleProcessingRequest } from './processing-worker.js';
import {
    prepareProcessingRehearsalRequest
} from './processing-rehearsal-faults.js';

export default {
    fetch(request, env, context) {
        return handleProcessingRequest(request, env, {
            accessContext: context?.access,
            prepareRehearsalRequest: prepareProcessingRehearsalRequest
        });
    }
};
