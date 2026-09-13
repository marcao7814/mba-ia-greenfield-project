import { ExecutionContext } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { ChannelNotOwnedException } from '../../common/exceptions/domain.exception';
import { JwtPayload } from '../../auth/auth.types';
import { Channel } from '../entities/channel.entity';
import { OwnedChannelGuard } from './owned-channel.guard';

function makeContext(params: Record<string, string>, user: JwtPayload) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params, user }) }),
  } as unknown as ExecutionContext;
}

describe('OwnedChannelGuard', () => {
  let guard: OwnedChannelGuard;
  let channelRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    channelRepository = { findOne: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        OwnedChannelGuard,
        {
          provide: getRepositoryToken(Channel),
          useValue: channelRepository,
        },
      ],
    }).compile();

    guard = module.get(OwnedChannelGuard);
  });

  it('allows the request when the channel belongs to the authenticated user', async () => {
    channelRepository.findOne.mockResolvedValue({
      id: 'channel-1',
      user_id: 'user-1',
    });
    const ctx = makeContext(
      { channelId: 'channel-1' },
      { sub: 'user-1', email: 'a@example.com' },
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws ChannelNotOwnedException when the channel belongs to another user', async () => {
    channelRepository.findOne.mockResolvedValue({
      id: 'channel-1',
      user_id: 'someone-else',
    });
    const ctx = makeContext(
      { channelId: 'channel-1' },
      { sub: 'user-1', email: 'a@example.com' },
    );

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      ChannelNotOwnedException,
    );
  });

  it('throws ChannelNotOwnedException when the channel does not exist (no existence leak)', async () => {
    channelRepository.findOne.mockResolvedValue(null);
    const ctx = makeContext(
      { channelId: 'nonexistent' },
      { sub: 'user-1', email: 'a@example.com' },
    );

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      ChannelNotOwnedException,
    );
  });
});
