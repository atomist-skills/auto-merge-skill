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

import { GitHubAppCredential } from "@atomist/skill/lib/secrets";
import * as github from "@octokit/rest";
import promiseRetry = require("promise-retry");
import { PullRequest } from "./types";

export const AutoMergeLabel = "auto-merge:on-approve";
export const AutoMergeCheckSuccessLabel = "auto-merge:on-check-success";
export const AutoMergeTag = `[${AutoMergeLabel}]`;
export const AutoMergeCheckSuccessTag = `[${AutoMergeCheckSuccessLabel}]`;

export const AutoMergeMethodLabel = "auto-merge-method:";
export const AutoMergeMethods = ["merge", "rebase", "squash"];

// tslint:disable-next-line:cyclomatic-complexity
export async function executeAutoMerge(pr: PullRequest,
                                       creds: GitHubAppCredential): Promise<void> {
    if (!!pr) {
        // 1. at least one approved review if PR isn't set to merge on successful build
        if (isPrTagged(pr, AutoMergeLabel, AutoMergeTag)) {
            if (!pr.reviews || pr.reviews.length === 0) {
                return;
            } else if (pr.reviews.some(r => r.state !== "approved")) {
                return;
            }
        }

        // 2. all status checks are successful and there is at least one check
        if (pr.head && pr.head.statuses && pr.head.statuses.length > 0) {
            if (pr.head.statuses.some(s => s.state !== "success")) {
                return;
            }
        } else {
            return;
        }

        if (isPrAutoMergeEnabled(pr)) {
            const api = gitHub(creds.token, apiUrl(pr.repo));

            return promiseRetry(async () => {

                    const gpr = await api.pulls.get({
                        owner: pr.repo.owner,
                        repo: pr.repo.name,
                        pull_number: pr.number,
                    });

                    if (gpr.data.mergeable === undefined || gpr.data.mergeable === null) {
                        throw new Error("GitHub PR mergeable state not available. Retrying...");
                    }

                    if (!!gpr.data.mergeable) {
                        await api.pulls.merge({
                            owner: pr.repo.owner,
                            repo: pr.repo.name,
                            pull_number: pr.number,
                            merge_method: mergeMethod(pr),
                            sha: pr.head.sha,
                            commit_title: `Auto merge pull request #${pr.number} from ${pr.repo.owner}/${pr.repo.name}`,
                        });
                        const body = `Pull request auto merged by Atomist.

* ${reviewComment(pr)}
* ${statusComment(pr)}`;

                        await api.issues.createComment({
                            owner: pr.repo.owner,
                            repo: pr.repo.name,
                            issue_number: pr.number,
                            body,
                        });
                        await api.git.deleteRef({
                            owner: pr.repo.owner,
                            repo: pr.repo.name,
                            ref: `heads/${pr.branch.name.trim()}`,
                        });
                    } else {
                        console.info("GitHub returned PR as not mergeable: '%j'", gpr.data);
                    }

                },
                {
                    retries: 5,
                    factor: 3,
                    minTimeout: 1 * 500,
                    maxTimeout: 5 * 1000,
                    randomize: true,
                });
        }
    }
}

export function isPrAutoMergeEnabled(pr: PullRequest): boolean {
    return isPrTagged(pr, AutoMergeLabel, AutoMergeTag)
        || isPrTagged(pr, AutoMergeCheckSuccessLabel, AutoMergeCheckSuccessTag);
}

function isPrTagged(pr: PullRequest,
                    label: string = AutoMergeLabel,
                    tag: string = AutoMergeTag): boolean {
    // 0. check labels
    if (pr.labels && pr.labels.some(l => l.name === label)) {
        return true;
    }

    // 1. check body and title for auto merge marker
    if (isTagged(pr.title, tag) || isTagged(pr.body, tag)) {
        return true;
    }

    // 2. PR comment that contains the merger
    if (pr.comments && pr.comments.some(c => isTagged(c.body, tag))) {
        return true;
    }

    // 3. Commit message containing the auto merge marker
    if (pr.commits && pr.commits.some(c => isTagged(c.message, tag))) {
        return true;
    }

    return false;
}

function mergeMethod(pr: PullRequest): "merge" | "rebase" | "squash" {
    const methodLabel = pr.labels.find(l => l.name.startsWith(AutoMergeMethodLabel));
    if (methodLabel && methodLabel.name.includes(":")) {
        const method = methodLabel.name.split(":")[1].toLowerCase() as any;
        if (AutoMergeMethods.includes(method)) {
            return method;
        }
    }
    return "merge";
}

function isTagged(msg: string, tag: string): boolean {
    return msg && msg.indexOf(tag) >= 0;
}

function reviewComment(pr: PullRequest): string {
    if (pr.reviews && pr.reviews.length > 0) {
        return `${pr.reviews.length} approved ${pr.reviews.length > 1 ? "reviews" : "review"} by ${pr.reviews.map(
            r => `${r.by.map(b => `@${b.login}`).join(", ")}`).join(", ")}`;
    } else {
        return "No reviews";
    }
}

function statusComment(pr: PullRequest): string {
    if (pr.head && pr.head.statuses && pr.head.statuses.length > 0) {
        return `${pr.head.statuses.length} successful ${pr.head.statuses.length > 1 ? "checks" : "check"}`;
    } else {
        return "No checks";
    }
}

export const DefaultGitHubApiUrl = "https://api.github.com/";

export function apiUrl(repo: any): string {
    if (repo.org && repo.org.provider && repo.org.provider.apiUrl) {
        let providerUrl = repo.org.provider.apiUrl;
        if (providerUrl.slice(-1) === "/") {
            providerUrl = providerUrl.slice(0, -1);
        }
        return providerUrl;
    } else {
        return DefaultGitHubApiUrl;
    }
}

export function gitHub(token: string, url: string = DefaultGitHubApiUrl): github {
    return new github({
        auth: `token ${token}`,
        baseUrl: url.endsWith("/") ? url.slice(0, -1) : url,
        throttle: {
            onRateLimit: (retryAfter: any, options: any) => {
                console.warn(`Request quota exhausted for request '${options.method} ${options.url}'`);

                if (options.request.retryCount === 0) { // only retries once
                    console.debug(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
                return false;
            },
            onAbuseLimit: (retryAfter: any, options: any) => {
                console.warn(`Abuse detected for request '${options.method} ${options.url}'`);
            },
        },
    });
}