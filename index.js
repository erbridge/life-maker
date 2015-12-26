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
  .then(function makeCommits(repository) {
    // TODO: Read the commit state.
    // TODO: Empty the repository.
    // TODO: Then create commits for the changing game state.
    // TODO: Then create commits for any new issues (and close them).
    // TODO: Then force push the changes.

    winston.info(repository);

    return Promise.resolve();
  })
  .catch(function onReject(err) {
    winston.error(err);
  });
