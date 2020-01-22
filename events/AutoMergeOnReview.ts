/*
 * Copyright © 2020 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventHandler } from "@atomist/skill/lib/handler";
import {
    GitHubAppCredential,
    gitHubAppToken,
} from "@atomist/skill/lib/secrets";
import { executeAutoMerge } from "./autoMerge";
import { AutoMergeOnReviewSubscription } from "./types";

export const handler: EventHandler<AutoMergeOnReviewSubscription> = async ctx => {
    const pr = ctx.data.Review[0].pullRequest;
    const { owner, name } = pr.repo;
    const credentials = await ctx.credential.resolve<GitHubAppCredential>(gitHubAppToken({ owner, repo: name }));
    await executeAutoMerge(pr, credentials);
};
