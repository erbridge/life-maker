'use strict';

const config = require('./config');

const path = require('path');

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

const READ_PATH  = path.join(config.get('github.localPath'), 'r');
const WRITE_PATH = path.join(config.get('github.localPath'), 'w');

const REMOTE_FULL_NAME =
  `${config.get('github.username')}/${config.get('github.repo.name')}`;

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

const getRemoteRepoInfo = function getRemoteRepoInfo() {
  const repo = githubClient.repo(REMOTE_FULL_NAME);

  return new Promise(function promiseToGetRemoteRepoInfo(resolve, reject) {
    repo.info(function handleResponse(err, data) {
      if (err) {
        return reject(err);
      }

      resolve(data);
    });
  });
};

const cloneRemoteRepo = function cloneRemoteRepo(repoInfo, localPath) {
  return rimraf(localPath)
    .then(function clone() {
      return NodeGit.Clone.clone(
        repoInfo.clone_url,
        localPath
      );
    });
};

const recreateReadRepo = function recreateReadRepo(repoInfo) {
  return cloneRemoteRepo(repoInfo, READ_PATH)
    .then(function resolveInfo() {
      return Promise.resolve(repoInfo);
    });
};

const recreateRemoteRepo = function recreateRemoteRepo() {
  const me   = githubClient.me();
  const repo = githubClient.repo(REMOTE_FULL_NAME);

  return new Promise(function promiseToDestroyRemoteRepo(resolve, reject) {
    repo.destroy(function catchError(err) {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  })
    .then(function createRemoteRepo() {
      return new Promise(function promiseToCreateRemoteRepo(resolve, reject) {
        me.repo(
          {
            name:        config.get('github.repo.name'),
            description: config.get('github.repo.description'),
          },
          function handleResponse(err, data) {
            if (err) {
              return reject(err);
            }

            resolve(data);
          }
        );
      });
    });
};

const recreateWriteRepo = function recreateWriteRepo(repoInfo) {
  return cloneRemoteRepo(repoInfo, WRITE_PATH)
    .then(function createInitialCommit(repository) {
      const sig = NodeGit.Signature.create(
        config.get('commit.name'), config.get('commit.email'), 0, 0
      );

      return repository.openIndex()
        .then(function writeTree(index) {
          return index.writeTree();
        })
        .then(function createCommit(tree) {
          return repository.createCommit(
            'HEAD', sig, sig, 'Initial commit', tree, []
          );
        });
    })
    .then(function resolveInfo() {
      return Promise.resolve(repoInfo);
    });
};

const stepLife = function stepLife() {
  return NodeGit.Repository.open(READ_PATH)
    .then(function getHeadCommit(repository) {
      return repository.getHeadCommit();
    })
    .then(function getCommits(firstCommit) {
      const commits = [];

      if (!firstCommit) {
        return Promise.resolve(commits);
      }

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

      commits.forEach(function incrementCount(commit) {
        const date = commit.date();

        if (date.getTime() === 0) {
          return;
        }

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

      now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

      const lastRowIndex = now.day();

      _.each(counts, function addToGrid(count, dateString) {
        const days  = now.diff(dateString, 'days');
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

const commitLife = function commitLife(lifeGrid) {
  const name    = config.get('commit.name');
  const email   = config.get('commit.email');
  const message = config.get('commit.message');

  return NodeGit.Repository.open(WRITE_PATH)
    .then(function makeCommits(repository) {
      const now = moment.utc();

      now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

      const sigs = [];

      forEachNode(lifeGrid, function createSig(node, x, y) {
        if (!node) {
          return;
        }

        const date = moment.utc(now);

        date.set({ week: now.week() - (lifeGrid.length - 1 - x), day: y });

        const sig = NodeGit.Signature.create(name, email, date.unix(), 0);

        sigs.push(sig);
      });

      if (!sigs.length) {
        return Promise.resolve();
      }

      const executeCommit = function executeCommit(i) {
        const sig = sigs[i];

        return repository.createCommitOnHead([], sig, sig, message)
          .then(function recurse() {
            i++;

            if (sigs.length > i) {
              return executeCommit(i);
            }

            return Promise.resolve();
          });
      };

      return executeCommit(0);
    });
};

const updateRemoteRepo = function updateRemoteRepo() {
  const cred = NodeGit.Cred.userpassPlaintextNew(
    config.get('github.username'), config.get('github.password')
  );

  return NodeGit.Repository.open(WRITE_PATH)
    .then(function getRemote(repository) {
      return repository.getRemote('origin');
    })
    .then(function push(remote) {
      return remote.push(
        [
          '+HEAD:refs/heads/master',
        ],
        {
          callbacks: {
            credentials: function credentials() {
              return cred;
            },
          },
        }
      );
    });
};

getRemoteRepoInfo()
  .then(recreateReadRepo)
  .then(recreateRemoteRepo)
  .then(recreateWriteRepo)
  .then(stepLife)
  // TODO: Then add life for any new issues (and close them).
  .then(commitLife)
  .then(updateRemoteRepo)
  .catch(function onReject(err) {
    winston.error(err);
  });
