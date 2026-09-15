import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelNotOwnedException } from '../../common/exceptions/domain.exception';
import { JwtPayload } from '../../auth/auth.types';
import { Channel } from '../entities/channel.entity';

@Injectable()
export class OwnedChannelGuard implements CanActivate {
  constructor(
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: Record<string, string>;
      user: JwtPayload;
    }>();

    const channelId = request.params.channelId;
    const channel = await this.channelRepository.findOne({
      where: { id: channelId },
    });

    if (!channel || channel.user_id !== request.user.sub) {
      throw new ChannelNotOwnedException();
    }

    return true;
  }
}
