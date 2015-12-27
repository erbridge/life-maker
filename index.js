'use strict';

const config = require('./config');

const _        = require('lodash');
const moment   = require('moment');
const NodeGit  = require('nodegit');
const octonode = require('octonode');
const rimraf   = require('rimraf-promise');
const winston  = require('winston');

const githubClient = octonode.client({
  username: config.get('github.username'),
  password: config.get('github.password'),
});

const createEmptyGrid = function createEmptyGrid() {
  // FIXME: Ignore the incomplete weeks, so the world can wrap.
  const columnCount = Math.ceil(365 / 7);

  const grid = [];

  while (grid.length < columnCount) {
    grid.push([]);
  }

  return grid;
};

const forEachNode = function forEachNode(grid, eachFn) {
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < 7; y++) {
      eachFn(grid[x][y], x, y);
    }
  }
};

const cloneRepo = function cloneRepo() {
  const repo = githubClient.repo(config.get('github.repo'));

  return Promise.all([
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
    .then(function clone(info) {
      const options = new NodeGit.CloneOptions();

      options.checkoutBranch = config.get('github.branch');

      return NodeGit.Clone.clone(
        info.clone_url, config.get('github.localPath'), options
      );
    });
};

const stepLife = function stepLife(repository) {
  return repository.getBranchCommit(config.get('github.branch'))
    .then(function getCommits(firstCommit) {
      const commits = [];

      const history = firstCommit.history(NodeGit.Revwalk.SORT.Time);

      return new Promise(function promiseToGetCommits(resolve, reject) {
        history.on('commit', function getCommit(commit) {
          commits.push(commit);
        });

        history.on('error', reject);

        history.on('end', function resolveCommits() {
          resolve(commits);
        });

        history.start();
      });
    })
    .then(function countCommits(commits) {
      const counts = {};

      commits.forEach(function incrementDate(commit) {
        const date = commit.date();

        date.setUTCHours(0, 0, 0, 0);

        const dateString = date.toJSON();

        if (!counts[dateString]) {
          counts[dateString] = 0;
        }

        counts[dateString]++;
      });

      return Promise.resolve(counts);
    })
    .then(function createGrid(counts) {
      const grid = createEmptyGrid();

      const now = moment.utc();

      now.hours(0, 0, 0, 0);

      const lastRowIndex = now.day();

      _.each(counts, function addToGrid(count, dateString) {
        const days = now.diff(dateString, 'days');
        const weeks = now.diff(dateString, 'weeks');

        const rowIndex = ((lastRowIndex - days) % 7 + 7) % 7;

        grid[grid.length - 1 - weeks][rowIndex] = count;
      });

      return Promise.resolve(grid);
    })
    .then(function stepGrid(grid) {
      const newGrid     = createEmptyGrid();
      const columnCount = newGrid.length;

      // TODO: Fade out the grid nodes instead of stepping them. Leave a trail?
      forEachNode(grid, function updateNewGrid(node, x, y) {
        let alive = false;

        if (node > 0) {
          alive = true;
        }

        let aliveNeighbours = 0;

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const nx = ((x + dx) % columnCount + columnCount) % columnCount;
            const ny = ((y + dy) % 7 + 7) % 7;

            if (grid[nx][ny] > 0) {
              aliveNeighbours++;
            }
          }
        }

        if (alive) {
          if (aliveNeighbours < 2 || aliveNeighbours > 3) {
            alive = false;
          }
        } else if (aliveNeighbours > 3) {
          alive = true;
        }

        if (alive) {
          newGrid[x][y] = 1;
        }
      });

      return Promise.resolve(newGrid);
    });
};

cloneRepo()
  .then(function alterLife(repository) {
    return Promise.all([
      Promise.resolve(repository),
      stepLife(repository),
    ]);
  })
  .then(function makeCommits() {
    // TODO: Empty the repository.
    // TODO: Then create commits for the changing game state.
    // TODO: Then create commits for any new issues (and close them).
    // TODO: Then force push the changes.

    return Promise.resolve();
  })
  .catch(function onReject(err) {
    winston.error(err);
  });
