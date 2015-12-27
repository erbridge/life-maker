'use strict';

const config = require('./config');

const NodeGit  = require('nodegit');
const octonode = require('octonode');
const rimraf   = require('rimraf-promise');
const winston  = require('winston');

const githubClient = octonode.client({
  username: config.get('github.username'),
  password: config.get('github.password'),
});

const repo = githubClient.repo(config.get('github.repo'));

Promise.all([
  new Promise(function promiseToGetRepoInfo(resolve, reject) {
    repo.info(function handleResponse(err, data) {
      if (err) {
        return reject(err);
      }

      resolve(data);
    });
  }),
  rimraf(config.get('github.localPath')),
])
  .then(function handleResults(results) {
    return results[0];
  })
  .then(function cloneRepo(info) {
    return NodeGit.Clone.clone(info.clone_url, config.get('github.localPath'));
  })
  .then(function getHeadId(reference) {
    return Promise.all([
      Promise.resolve(reference),
      reference.head(),
    ]);
  })
  .then(function getRevWalk(results) {
    const repository = results[0];
    const reference  = results[1];

    return Promise.resolve([
      reference.target(),
      repository.createRevWalk(reference.target()),
    ]);
  })
  .then(function getCommits(results) {
    const headId  = results[0];
    const revWalk = results[1];

    return new Promise(function promiseToGetCommits(resolve, reject) {
      const commits = [];

      revWalk.walk(headId, function getCommit(err, commit) {
        // FIXME: NodeGit seems to throw an error after the last commit.
        // if (err) {
        //   return reject(err);
        // }

        if (!commit) {
          return resolve(commits);
        }

        commits.push(commit);
      });
    });
  })
  .then(function groupNodes(commits) {
    console.log(commits.length);
  })
  .then(function makeCommits() {
    // TODO: Read the commit state.
    // TODO: Empty the repository.
    // TODO: Then create commits for the changing game state.
    // TODO: Then create commits for any new issues (and close them).
    // TODO: Then force push the changes.

    return Promise.resolve();
  })
  .catch(function onReject(err) {
    winston.error(err);
  });
